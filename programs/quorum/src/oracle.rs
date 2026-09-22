//! Pyth price reads for the underlying asset.
//!
//! Invariant 1 (`README.md`): NAV never reads a DEX price. Everything here
//! reads a Pyth `PriceUpdateV2` for the real asset, never for a wrapper.
//!
//! Two guards carry the weight. Staleness, because `PriceUpdateV2` has no
//! trading-status field, which leaves `max_age` as the only way to tell a
//! closed market from a healthy feed. And
//! confidence, because Pyth publishes an interval, and a wide one means the
//! publishers disagree.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::errors::QuorumError;
use crate::state::Vault;

/// A validated oracle observation, converted to integer fixed point.
#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
    /// USD per unit (per share, or per troy ounce), scaled by `PRICE_SCALE`.
    pub price_fp: u128,
    /// Confidence interval in the same fixed point.
    pub conf_fp: u128,
    /// `conf / price` in basis points. Cheap for callers to log or surface.
    pub conf_bps: u64,
    pub publish_time: i64,
}

/// Convert Pyth's `(mantissa, exponent)` pair into fixed point at
/// `PRICE_SCALE`.
///
/// Equity and metal feeds publish a negative exponent, typically -8, so the
/// common path is a division. A positive exponent is legal and handled.
pub fn to_price_fp(mantissa: u64, exponent: i32) -> Result<u128> {
    let m = mantissa as u128;
    if exponent <= 0 {
        let div = 10u128
            .checked_pow((-exponent) as u32)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;
        m.checked_mul(PRICE_SCALE)
            .ok_or_else(|| error!(QuorumError::MathOverflow))
            .map(|v| v / div)
    } else {
        let mul = 10u128
            .checked_pow(exponent as u32)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;
        m.checked_mul(PRICE_SCALE)
            .and_then(|v| v.checked_mul(mul))
            .ok_or_else(|| error!(QuorumError::MathOverflow))
    }
}

/// Map the SDK's error onto ours, so a caller can tell staleness from a feed
/// mismatch without decoding someone else's enum.
pub fn map_pyth_err(e: pyth_solana_receiver_sdk::error::GetPriceError) -> Error {
    use pyth_solana_receiver_sdk::error::GetPriceError::*;
    match e {
        PriceTooOld => error!(QuorumError::OracleStale),
        MismatchedFeedId => error!(QuorumError::OracleFeedMismatch),
        InvalidWindowSize => error!(QuorumError::TwapWindowMismatch),
        _ => error!(QuorumError::OracleInvalidPrice),
    }
}

/// Read and validate the vault's underlying price.
///
/// `get_price_no_older_than` checks the feed id, staleness and verification
/// level. This adds the confidence bound, which the SDK does not enforce.
pub fn read_underlying_price(
    price_update: &Account<'_, PriceUpdateV2>,
    vault: &Vault,
    clock: &Clock,
) -> Result<OraclePrice> {
    let price = price_update
        .get_price_no_older_than(clock, vault.max_age_seconds, &vault.underlying_feed_id)
        .map_err(map_pyth_err)?;

    // A non-positive price is not a cheap asset, it is a broken feed.
    if price.price <= 0 {
        return Err(error!(QuorumError::OracleInvalidPrice));
    }
    let mantissa = price.price as u64;

    let price_fp = to_price_fp(mantissa, price.exponent)?;
    let conf_fp = to_price_fp(price.conf, price.exponent)?;
    if price_fp == 0 {
        return Err(error!(QuorumError::OracleInvalidPrice));
    }

    let conf_bps = conf_fp
        .checked_mul(BPS_DENOM as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / price_fp;
    let conf_bps = u64::try_from(conf_bps).unwrap_or(u64::MAX);

    require!(
        conf_bps <= vault.max_conf_bps as u64,
        QuorumError::OracleConfidenceTooWide
    );

    Ok(OraclePrice {
        price_fp,
        conf_fp,
        conf_bps,
        publish_time: price.publish_time,
    })
}

/// Read the underlying's averaged price, for the depeg test.
///
/// `Quorum_Spec_v5.pdf` §9.1 rules out comparing spot ticks, so that one
/// sandwiched block cannot fake a depeg and trigger the vault's defences.
/// The average used is Pyth's exponentially weighted moving price, which
/// every `PriceUpdateV2` already carries alongside spot in the same account.
///
/// It is not the TWAP the specification names. Pyth publishes no TWAP that
/// can be obtained: the HTTP route for them returns 404 on full
/// entitlement, and the whole of mainnet holds two `TwapUpdate` accounts,
/// both years stale. The EMA has the property
/// the rule is actually about, since it is aggregated over roughly an hour
/// of publisher updates and no single block moves it, and it has the
/// considerable advantage of existing.
///
/// Both sides of the comparison are averaged the same way. Comparing a
/// wrapper's average against the underlying's spot would read any fast move
/// in the underlying as a simultaneous depeg of every wrapper.
///
/// NAV, mint and redeem use spot; only the depeg paths use this.
pub fn read_underlying_ema(
    price_update: &PriceUpdateV2,
    vault: &Vault,
    clock: &Clock,
) -> Result<u128> {
    // Checks the feed id, the staleness and the verification level. The EMA
    // travels in the same message as the spot price it validates.
    price_update
        .get_price_no_older_than(clock, vault.max_age_seconds, &vault.underlying_feed_id)
        .map_err(map_pyth_err)?;

    let m = &price_update.price_message;
    require!(m.ema_price > 0, QuorumError::OracleInvalidPrice);

    let ema_fp = to_price_fp(m.ema_price as u64, m.exponent)?;
    let conf_fp = to_price_fp(m.ema_conf, m.exponent)?;
    require_conf_within(ema_fp, conf_fp, vault.max_conf_bps)?;
    Ok(ema_fp)
}

/// Require a feed's confidence interval to be within `max_conf_bps` of its
/// price. Shared by every read that has an interval to check.
pub fn require_conf_within(price_fp: u128, conf_fp: u128, max_conf_bps: u16) -> Result<()> {
    require!(price_fp > 0, QuorumError::OracleInvalidPrice);
    let bps = conf_fp
        .checked_mul(BPS_DENOM as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / price_fp;
    require!(
        bps <= max_conf_bps as u128,
        QuorumError::OracleConfidenceTooWide
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The common case: Pyth publishes NVDA at 220.95 with exponent -8.
    #[test]
    fn negative_exponent_is_the_common_path() {
        let fp = to_price_fp(22_095_000_000, -8).unwrap();
        assert_eq!(fp, 220_950_000_000); // 220.95 * 1e9
    }

    #[test]
    fn zero_exponent_passes_through() {
        assert_eq!(to_price_fp(4357, 0).unwrap(), 4357 * PRICE_SCALE);
    }

    #[test]
    fn positive_exponent_scales_up() {
        assert_eq!(to_price_fp(43, 2).unwrap(), 4300 * PRICE_SCALE);
    }

    /// Gold at ~$4357/oz with exponent -8, the qGOLD case.
    #[test]
    fn gold_price_roundtrips() {
        let fp = to_price_fp(435_705_450_000, -8).unwrap();
        assert_eq!(fp, 4_357_054_500_000);
    }
}
