//! On-chain depeg detection (`Quorum_Spec_v5.pdf` §9.1).
//!
//! A depeg must be provable from accounts the program reads itself, or
//! `swap_depegged` cannot be left open to anyone.
//!
//! ```text
//! implied_i = wrapper_units(1 token) * unit_price  // oracle fair value
//! dex_i     = market price of 1 wrapper token      // Pyth TWAP
//! dev_i     = dex_i / implied_i - 1                // signed
//! ```
//!
//! Both sides are TWAPs over the same window, and fair value goes through
//! `wrapper_units` so the live multiplier is included. The sign decides which
//! side of the trade is legal: sell the rich wrapper, buy the cheap one.
//!
//! Three of the registered wrappers have no Pyth feed and cannot be
//! depeg-checked on-chain at all.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::errors::QuorumError;
use crate::oracle::{map_pyth_err, require_conf_within, to_price_fp};
use crate::state::{Vault, WrapperConfig};
use crate::units::wrapper_units;

/// Signed deviation of a wrapper's market price from its oracle fair value.
///
/// Always from a Pyth TWAP (spec §9.1): there is deliberately no spot reader
/// on-chain, so nothing can classify a depeg off a single tick.
#[derive(Clone, Copy, Debug)]
pub struct Deviation {
    /// Market price of one wrapper token, USD at `PRICE_SCALE`.
    pub dex_price_fp: u128,
    /// Oracle fair value of one wrapper token, USD at `PRICE_SCALE`.
    pub implied_fp: u128,
    /// `dex / implied - 1`, in basis points. Negative means trading cheap.
    pub dev_bps: i64,
}

/// Fair value of one whole wrapper token, USD at `PRICE_SCALE`.
///
/// Goes through `wrapper_units`, the same path NAV uses, so the live Scaled UI
/// multiplier is included. Without it, a wrapper priced exactly at its NAV
/// value reads as rich by the whole multiplier, 94bps for SPYon today.
pub fn implied_price_live(
    wrapper: &WrapperConfig,
    mint_data: &[u8],
    now_ts: i64,
    unit_price_fp: u128,
) -> Result<u128> {
    let one_token = 10u64
        .checked_pow(wrapper.decimals as u32)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    let units = wrapper_units(wrapper, one_token, mint_data, now_ts)?;
    units
        .checked_mul(unit_price_fp)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / UNITS_SCALE)
}

/// What the guard table (spec §9.2) says a given deviation should do.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum DepegVerdict {
    /// Inside the soft threshold.
    Healthy,
    /// Past soft, but not yet held for `min_duration`. Start or keep the clock.
    Watching,
    /// Past soft and persistent: MINT_DISABLED, `swap_depegged` opens.
    SoftDepeg,
    /// Past hard: QUARANTINE immediately, no persistence requirement. An issuer
    /// 5% off peg is not a blip worth waiting out.
    HardDepeg,
}

/// Classify a deviation. Pure, so the thresholds are testable without a chain.
///
/// `depeg_since_ts` is when the deviation first crossed soft in the current
/// direction; zero means the clock is not running.
pub fn classify(
    dev_bps: i64,
    depeg_since_ts: i64,
    depeg_direction: i8,
    now_ts: i64,
    soft_bps: u16,
    hard_bps: u16,
    min_duration: i64,
) -> DepegVerdict {
    let magnitude = dev_bps.unsigned_abs();
    let direction: i8 = if dev_bps >= 0 { 1 } else { -1 };

    if magnitude >= hard_bps as u64 {
        return DepegVerdict::HardDepeg;
    }
    if magnitude < soft_bps as u64 {
        return DepegVerdict::Healthy;
    }

    // Past soft. A flip in direction restarts the clock: a wrapper that swung
    // from rich to cheap has not been "depegged for 10 minutes", it has had two
    // different problems.
    if depeg_since_ts == 0 || depeg_direction != direction {
        return DepegVerdict::Watching;
    }
    if now_ts.saturating_sub(depeg_since_ts) >= min_duration {
        DepegVerdict::SoftDepeg
    } else {
        DepegVerdict::Watching
    }
}

/// Measure a wrapper's deviation from `implied_fp`, using Pyth's averaged
/// price for that wrapper.
///
/// Averaged rather than spot for the reason in `oracle::read_underlying_ema`:
/// a single block must not be able to manufacture a depeg. Both sides of the
/// comparison use the same kind of average.
pub fn read_deviation_ema(
    wrapper: &WrapperConfig,
    vault: &Vault,
    price_update: &PriceUpdateV2,
    implied_fp: u128,
    clock: &Clock,
) -> Result<Deviation> {
    require!(wrapper.has_wrapper_feed, QuorumError::NoWrapperPriceSource);

    // Feed id, staleness and verification level, on the wrapper's own feed.
    price_update
        .get_price_no_older_than(clock, vault.max_age_seconds, &wrapper.wrapper_feed_id)
        .map_err(map_pyth_err)?;

    let m = &price_update.price_message;
    require!(m.ema_price > 0, QuorumError::OracleInvalidPrice);

    let dex_price_fp = to_price_fp(m.ema_price as u64, m.exponent)?;
    let conf_fp = to_price_fp(m.ema_conf, m.exponent)?;
    require_conf_within(dex_price_fp, conf_fp, vault.max_conf_bps)?;
    require!(implied_fp > 0, QuorumError::OracleInvalidPrice);

    let dev_bps =
        ((dex_price_fp as i128 - implied_fp as i128) * BPS_DENOM as i128) / implied_fp as i128;

    Ok(Deviation {
        dex_price_fp,
        implied_fp,
        dev_bps: i64::try_from(dev_bps).map_err(|_| error!(QuorumError::MathOverflow))?,
    })
}

/// Compare the mint's Scaled UI multiplier against Pyth's redemption rate.
///
/// Two independent measurements of how much underlying one wrapper token is
/// worth: the Token-2022 multiplier on the mint, and Pyth's `.RR` feed. A
/// disagreement means either an issuer change Pyth has not priced in, or the
/// program reading the multiplier wrongly, which is the silent bug invariant 5
/// (`README.md`) exists to prevent.
pub fn rr_divergence_bps(on_chain_units_fp: u128, rr_fp: u128) -> Result<u64> {
    require!(rr_fp > 0, QuorumError::OracleInvalidPrice);
    let diff = on_chain_units_fp.abs_diff(rr_fp);
    let bps = diff
        .checked_mul(BPS_DENOM as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / rr_fp;
    Ok(u64::try_from(bps).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOFT: u16 = 200; // 2%
    const HARD: u16 = 500; // 5%
    const DUR: i64 = 600; // 10 min

    #[test]
    fn inside_the_band_is_healthy() {
        assert_eq!(
            classify(150, 0, 0, 1_000, SOFT, HARD, DUR),
            DepegVerdict::Healthy
        );
        assert_eq!(
            classify(-199, 0, 0, 1_000, SOFT, HARD, DUR),
            DepegVerdict::Healthy
        );
    }

    #[test]
    fn crossing_soft_starts_the_clock_rather_than_acting() {
        assert_eq!(
            classify(-250, 0, 0, 1_000, SOFT, HARD, DUR),
            DepegVerdict::Watching
        );
    }

    /// A required test: a deviation that is too brief must not open
    /// `swap_depegged`.
    #[test]
    fn brief_deviation_does_not_open_the_swap() {
        // Crossed 9 minutes ago; needs 10.
        assert_eq!(
            classify(-250, 1_000, -1, 1_000 + 540, SOFT, HARD, DUR),
            DepegVerdict::Watching
        );
    }

    #[test]
    fn persistent_deviation_opens_the_swap() {
        assert_eq!(
            classify(-250, 1_000, -1, 1_000 + 600, SOFT, HARD, DUR),
            DepegVerdict::SoftDepeg
        );
    }

    #[test]
    fn hard_depeg_needs_no_persistence() {
        assert_eq!(
            classify(-501, 0, 0, 0, SOFT, HARD, DUR),
            DepegVerdict::HardDepeg
        );
        assert_eq!(
            classify(600, 0, 0, 0, SOFT, HARD, DUR),
            DepegVerdict::HardDepeg
        );
    }

    /// A wrapper that swings rich-to-cheap has not been depegged continuously.
    /// Without this, an oscillating price would look persistent.
    #[test]
    fn direction_flip_restarts_the_clock() {
        assert_eq!(
            classify(250, 1_000, -1, 1_000 + 900, SOFT, HARD, DUR),
            DepegVerdict::Watching
        );
    }

    #[test]
    fn deviation_is_symmetric_in_sign() {
        assert_eq!(
            classify(250, 1_000, 1, 1_000 + 600, SOFT, HARD, DUR),
            DepegVerdict::SoftDepeg
        );
    }

    #[test]
    fn implied_price_scales_by_units_per_token() {
        let mut w = crate::state::WrapperConfig {
            decimals: 8,
            units_per_token: UNIT_SCALE,
            ..Default::default()
        };
        // Fixed wrapper, empty mint data: 1 token = 1 share at $200 -> $200.
        assert_eq!(
            implied_price_live(&w, &[], 0, 200 * PRICE_SCALE).unwrap(),
            200 * PRICE_SCALE
        );
        // 1 token = half a share -> $100.
        w.units_per_token = UNIT_SCALE / 2;
        assert_eq!(
            implied_price_live(&w, &[], 0, 200 * PRICE_SCALE).unwrap(),
            100 * PRICE_SCALE
        );
    }

    #[test]
    fn identical_measurements_do_not_diverge() {
        assert_eq!(rr_divergence_bps(UNIT_SCALE, UNIT_SCALE).unwrap(), 0);
    }

    /// The SPYx multiplier read from mainnet, against a redemption rate that
    /// agrees with it. Must stay inside tolerance.
    #[test]
    fn real_spyx_multiplier_agrees_with_its_redemption_rate() {
        let mint_says = 1_003_909_240u128; // 1.00390924 at UNIT_SCALE
        let pyth_says = 1_003_900_000u128;
        assert!(rr_divergence_bps(mint_says, pyth_says).unwrap() < MAX_RR_DIVERGENCE_BPS);
    }

    /// The failure this exists to catch: reading the raw balance is equivalent
    /// to believing the multiplier is 1.0, so against a drifted redemption rate
    /// the disagreement must exceed tolerance. Also why `MAX_RR_DIVERGENCE_BPS`
    /// is 50: at 100, SPYon's real 94bps drift slips underneath and the check
    /// misses the bug it was written for.
    #[test]
    fn reading_raw_instead_of_scaled_is_detected() {
        let believed_if_reading_raw = UNIT_SCALE; // 1.0
        let pyth_says = 1_009_473_072u128; // SPYon's real 1.0094730728
        let d = rr_divergence_bps(believed_if_reading_raw, pyth_says).unwrap();
        assert_eq!(d, 93, "SPYon's cumulative drift, in bps");
        assert!(
            d > MAX_RR_DIVERGENCE_BPS,
            "invariant 5 regression must be caught at runtime: divergence was only {d}bps \
             against a {MAX_RR_DIVERGENCE_BPS}bps tolerance"
        );
    }

    /// The other side of the calibration: normal publisher noise and ex-date
    /// lag must not quarantine a healthy wrapper.
    #[test]
    fn ordinary_lag_does_not_quarantine() {
        // Pyth 20bps behind the mint, e.g. mid-dividend.
        let d = rr_divergence_bps(1_002_000_000, 1_000_000_000).unwrap();
        assert!(d < MAX_RR_DIVERGENCE_BPS, "{d}bps should be tolerated");
    }

    #[test]
    fn divergence_is_symmetric() {
        let a = rr_divergence_bps(1_100_000_000, 1_000_000_000).unwrap();
        let b = rr_divergence_bps(900_000_000, 1_000_000_000).unwrap();
        assert_eq!(a, 1_000);
        assert_eq!(b, 1_000);
    }
}
