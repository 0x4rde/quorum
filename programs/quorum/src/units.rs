//! Converting a wrapper's on-chain token balance into underlying units.
//!
//! This module is invariant 5 (`README.md`): a Token-2022 balance is read as
//! the Scaled UI Amount, never raw. Reading raw reverts nothing, so no caller
//! can obtain a raw balance from here. The one public entry point applies the
//! multiplier and errors when the mint and the `WrapperConfig` disagree about
//! whether a multiplier exists.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Mint as SplMint,
};

use crate::constants::{MULTIPLIER_SCALE, UNITS_SCALE, UNIT_SCALE};
use crate::errors::QuorumError;
use crate::state::{MultiplierSource, WrapperConfig};

/// `a * b / d`, rounded to nearest rather than truncated.
///
/// Every step below divides, and truncating at each one biases the valuation
/// downward, in the same direction as the bug this module prevents. Rounding
/// to nearest keeps the error unbiased. Rounding mint and redeem amounts
/// against the user is the caller's job, not this function's.
fn mul_div_round(a: u128, b: u128, d: u128) -> Result<u128> {
    let prod = a
        .checked_mul(b)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    let half = d / 2;
    prod.checked_add(half)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / d)
}

/// The Scaled UI multiplier as fixed point at `MULTIPLIER_SCALE`. 1.0 -> 1e18.
///
/// Token-2022 stores this as an f64. It is read once and converted, because
/// f64 rounding has no business near a balance sheet.
fn multiplier_fp_from_mint(mint_data: &[u8], now_ts: i64) -> Result<Option<u128>> {
    let state = StateWithExtensions::<SplMint>::unpack(mint_data)
        .map_err(|_| error!(QuorumError::MathOverflow))?;

    let config = match state.get_extension::<ScaledUiAmountConfig>() {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };

    // A scheduled multiplier takes effect at its timestamp. Reading the wrong
    // side of that boundary is the same accounting bug, one tick late.
    let effective_ts: i64 = config.new_multiplier_effective_timestamp.into();
    let raw: f64 = if now_ts >= effective_ts {
        config.new_multiplier.into()
    } else {
        config.multiplier.into()
    };

    if !raw.is_finite() || raw <= 0.0 {
        return Err(error!(QuorumError::MathOverflow));
    }

    let scaled = (raw * (MULTIPLIER_SCALE as f64)).round();
    if scaled < 1.0 || scaled > (u128::MAX / 2) as f64 {
        return Err(error!(QuorumError::MathOverflow));
    }
    Ok(Some(scaled as u128))
}

/// Underlying units held, in nano-units (`UNITS_SCALE`), for one wrapper.
///
/// ```text
/// units = raw_balance / 10^decimals * scaled_ui_multiplier * units_per_token
/// ```
///
/// `mint_data` must be the account data of `wrapper.wrapper_mint`, whose key
/// the caller is responsible for checking. This checks the shape, meaning
/// whether the extension is present, against the config.
pub fn wrapper_units(
    wrapper: &WrapperConfig,
    raw_balance: u64,
    mint_data: &[u8],
    now_ts: i64,
) -> Result<u128> {
    let multiplier_fp: u128 = match wrapper.multiplier_source {
        MultiplierSource::Token2022ScaledUi => {
            // Configured to read the extension, so it must be present. If the
            // issuer removed it, stop rather than fall back to raw.
            multiplier_fp_from_mint(mint_data, now_ts)?
                .ok_or_else(|| error!(QuorumError::ScaledUiExtensionMissing))?
        }
        MultiplierSource::Fixed | MultiplierSource::KeeperPushed => {
            // Symmetric guard: a mint that grows a Scaled UI extension after
            // registration as Fixed makes every later NAV read wrong. This is
            // the live case, since the spec calls Ondo fixed and the mint
            // disagrees.
            if wrapper.is_token_2022 && multiplier_fp_from_mint(mint_data, now_ts)?.is_some() {
                return Err(error!(QuorumError::ScaledUiConfigMismatch));
            }
            MULTIPLIER_SCALE
        }
    };

    let divisor = 10u128
        .checked_pow(wrapper.decimals as u32)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;

    // Divide in steps. Multiplying all four terms first overflows u128 at
    // realistic sizes: 1,000 tokens at 9 decimals against a 1e18 multiplier is
    // already 1e39. Stepwise the widest intermediate is about 1.8e37.
    let scaled_balance = mul_div_round(raw_balance as u128, multiplier_fp, MULTIPLIER_SCALE)?;
    let base_units = mul_div_round(scaled_balance, wrapper.units_per_token, UNIT_SCALE)?;
    mul_div_round(base_units, UNITS_SCALE, divisor)
}

/// Apply a NAV haircut in basis points to a unit quantity (`Quorum_Spec_v5.pdf`
/// §4).
pub fn apply_haircut(units: u128, haircut_bps: u16) -> Result<u128> {
    if haircut_bps == 0 {
        return Ok(units);
    }
    let keep = 10_000u128
        .checked_sub(haircut_bps as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    units
        .checked_mul(keep)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrapper(source: MultiplierSource, decimals: u8, upt: u128) -> WrapperConfig {
        WrapperConfig {
            decimals,
            is_token_2022: matches!(source, MultiplierSource::Token2022ScaledUi),
            units_per_token: upt,
            multiplier_source: source,
            target_weight_bps: 3_333,
            max_weight_bps: 4_000,
            ..Default::default()
        }
    }

    /// A plain SPL wrapper with 1 token = 1 share. 5 tokens at 8 decimals = 5
    /// units.
    #[test]
    fn fixed_one_to_one() {
        let w = wrapper(MultiplierSource::Fixed, 8, UNIT_SCALE);
        let units = wrapper_units(&w, 5 * 100_000_000, &[], 0).unwrap();
        assert_eq!(units, 5 * UNITS_SCALE);
    }

    /// Ondo's mechanism: units_per_token stays 1 and the balance itself grows.
    /// NAV must follow the balance with no multiplier involved.
    #[test]
    fn ondo_dividend_grows_balance() {
        let w = wrapper(MultiplierSource::Fixed, 8, UNIT_SCALE);
        let before = wrapper_units(&w, 100 * 100_000_000, &[], 0).unwrap();
        let after = wrapper_units(&w, 103 * 100_000_000, &[], 0).unwrap();
        assert_eq!(before, 100 * UNITS_SCALE);
        assert_eq!(after, 103 * UNITS_SCALE);
    }

    /// A wrapper token that represents a fraction of a share.
    #[test]
    fn fractional_units_per_token() {
        let w = wrapper(MultiplierSource::Fixed, 6, UNIT_SCALE / 2);
        let units = wrapper_units(&w, 10 * 1_000_000, &[], 0).unwrap();
        assert_eq!(units, 5 * UNITS_SCALE);
    }

    #[test]
    fn haircut_applies() {
        assert_eq!(apply_haircut(1_000, 0).unwrap(), 1_000);
        assert_eq!(apply_haircut(1_000, 1_000).unwrap(), 900);
        assert_eq!(apply_haircut(1_000, 10_000).unwrap(), 0);
    }
}
