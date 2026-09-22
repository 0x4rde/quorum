//! The arithmetic that decides who gets how much.
//!
//! Kept out of the instruction handlers so they can be tested without a
//! validator, a mint or an oracle. A bug in any of them is a silent transfer
//! of value between users.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuorumError;

/// Index tokens to mint for a deposit, before fees.
///
/// The first mint bootstraps the rate at one index token per unit of account.
/// Every mint after that prices against NAV, which is what keeps existing
/// holders undiluted.
pub fn gross_index_for_deposit(
    supply: u64,
    deposit_units: u128,
    deposit_value: u128,
    nav_per_token: u128,
) -> Result<u128> {
    let index_one = 10u128.pow(INDEX_DECIMALS as u32);
    if supply == 0 {
        return deposit_units
            .checked_mul(index_one)
            .ok_or_else(|| error!(QuorumError::MathOverflow))
            .map(|v| v / UNITS_SCALE);
    }
    require!(nav_per_token > 0, QuorumError::ZeroSupply);
    deposit_value
        .checked_mul(index_one)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / nav_per_token)
}

/// Apply a fee in basis points by withholding, not collecting.
///
/// There is no fee account in this program. A mint fee means fewer index
/// tokens for the same deposit, a redeem fee a smaller payout for the same
/// burn, and either way the difference stays in the basket and lifts NAV for
/// everyone who did not just transact (`Quorum_Spec_v5.pdf` §10).
pub fn apply_fee(amount: u128, fee_bps: u16) -> Result<u128> {
    require!(fee_bps < BPS_DENOM as u16, QuorumError::MathOverflow);
    amount
        .checked_mul((BPS_DENOM - fee_bps as u64) as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / BPS_DENOM as u128)
}

/// One leg of a pro-rata in-kind redeem.
///
/// Operates on the raw balance on purpose: the Scaled UI multiplier applies
/// equally to what the vault holds and to what the redeemer receives, so it
/// cancels out of the ratio. Always rounds down, or a sequence of dust redeems
/// would drain the vault a lamport at a time.
pub fn prorata_out(vault_balance: u64, effective_burn: u128, supply: u64) -> Result<u64> {
    if supply == 0 {
        return Ok(0);
    }
    let out = (vault_balance as u128)
        .checked_mul(effective_burn)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / supply as u128;
    u64::try_from(out).map_err(|_| error!(QuorumError::MathOverflow))
}

/// A wrapper's weight in the basket, in basis points, measured in units.
pub fn weight_bps(wrapper_units: u128, total_units: u128) -> Result<u128> {
    if total_units == 0 {
        return Ok(0);
    }
    wrapper_units
        .checked_mul(BPS_DENOM as u128)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / total_units)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX_ONE: u128 = 1_000_000_000; // 1e9, INDEX_DECIMALS

    #[test]
    fn first_mint_bootstraps_one_token_per_unit() {
        // 10 troy ounces into an empty qGOLD vault -> 10 qGOLD.
        let gross = gross_index_for_deposit(0, 10 * UNITS_SCALE, 43_570 * NAV_SCALE, 0).unwrap();
        assert_eq!(gross, 10 * INDEX_ONE);
    }

    #[test]
    fn later_mints_price_against_nav() {
        // Vault at $187.42/token. Deposit worth $1874.20 -> 10 tokens.
        let nav_per_token = 187_420_000_000; // 187.42 at NAV_SCALE
        let deposit_value = 1_874_200_000_000; // 1874.20
        let gross = gross_index_for_deposit(
            1_000 * 1_000_000_000,
            10 * UNITS_SCALE,
            deposit_value,
            nav_per_token,
        )
        .unwrap();
        assert_eq!(gross, 10 * INDEX_ONE);
    }

    #[test]
    fn fee_withholds_rather_than_collects() {
        // 10 bps on 1000 tokens leaves 999.
        assert_eq!(apply_fee(1_000 * INDEX_ONE, 10).unwrap(), 999 * INDEX_ONE);
        assert_eq!(apply_fee(1_000, 0).unwrap(), 1_000);
    }

    #[test]
    fn prorata_splits_by_supply_share() {
        // Burning 10% of supply claims 10% of each leg.
        assert_eq!(prorata_out(1_000_000, 100, 1_000).unwrap(), 100_000);
    }

    #[test]
    fn prorata_rounds_down_so_dust_cannot_drain() {
        // 1 unit of balance, 1/3 of supply: 0.333... must floor to 0, not 1.
        assert_eq!(prorata_out(1, 1, 3).unwrap(), 0);
        assert_eq!(prorata_out(10, 1, 3).unwrap(), 3);
    }

    #[test]
    fn prorata_of_full_supply_takes_everything() {
        assert_eq!(prorata_out(12_345_678, 1_000, 1_000).unwrap(), 12_345_678);
    }

    /// Round trip: mint then redeem returns the deposit minus fees, with no
    /// value leak.
    ///
    /// A user deposits into an established vault and immediately redeems. They
    /// must get back their deposit less exactly the two fees, never more (that
    /// is a leak from other holders) and never meaningfully less (that is a
    /// silent tax).
    #[test]
    fn round_trip_returns_deposit_minus_fees() {
        let fee_mint_bps = 10u16;
        let fee_redeem_bps = 10u16;

        // Established vault: 1,000 index tokens against 1,000 wrapper tokens.
        let supply: u64 = 1_000 * 1_000_000_000;
        let vault_balance: u64 = 1_000 * 100_000_000; // 8 decimals
        let nav_per_token: u128 = 187_420_000_000;

        // Deposit 10 wrapper tokens, worth 10 units.
        let deposit_units = 10 * UNITS_SCALE;
        let deposit_value = deposit_units * nav_per_token / UNITS_SCALE;
        let deposit_raw: u64 = 10 * 100_000_000;

        let gross =
            gross_index_for_deposit(supply, deposit_units, deposit_value, nav_per_token).unwrap();
        let minted = apply_fee(gross, fee_mint_bps).unwrap();
        let minted_u64 = u64::try_from(minted).unwrap();

        // Redeem the whole position right back.
        let supply_after = supply + minted_u64;
        let balance_after = vault_balance + deposit_raw;
        let effective = apply_fee(minted, fee_redeem_bps).unwrap();
        let returned = prorata_out(balance_after, effective, supply_after).unwrap();

        // The answer sits slightly above the naive deposit * 0.999 * 0.999,
        // because fees are withheld into the basket rather than collected: by
        // the time the depositor redeems they are a holder, clawing back their
        // pool share of the fee they just paid. Below `naive` would mean fees
        // taken twice; above `deposit_raw` would mean value leaking out of
        // other holders' pockets.
        let naive = (deposit_raw as u128) * 9_990 / 10_000 * 9_990 / 10_000;

        assert!(
            returned <= deposit_raw,
            "round trip returned MORE than deposited ({returned} > {deposit_raw}): \
             value leaked from other holders"
        );
        assert!(
            (returned as u128) >= naive,
            "round trip returned less than deposit minus both fees ({returned} < {naive}): \
             the depositor is being charged more than the stated fee"
        );

        // The clawback is bounded by their share of the pool. They deposited
        // ~1% of the vault, so they recover ~1% of their own fee, no more.
        let clawback = returned as u128 - naive;
        let fee_paid = deposit_raw as u128 - naive;
        assert!(
            clawback * 50 < fee_paid,
            "clawback {clawback} is too large a fraction of the {fee_paid} paid: \
             a depositor should not recover a meaningful share of their own fee"
        );
    }

    /// The same round trip with fees off must be value-neutral to within dust.
    /// If this drifts, the leak is in the arithmetic rather than the fees.
    #[test]
    fn round_trip_with_no_fees_is_value_neutral() {
        let supply: u64 = 1_000 * 1_000_000_000;
        let vault_balance: u64 = 1_000 * 100_000_000;
        let nav_per_token: u128 = 187_420_000_000;

        let deposit_units = 10 * UNITS_SCALE;
        let deposit_value = deposit_units * nav_per_token / UNITS_SCALE;
        let deposit_raw: u64 = 10 * 100_000_000;

        let minted =
            gross_index_for_deposit(supply, deposit_units, deposit_value, nav_per_token).unwrap();
        let minted_u64 = u64::try_from(minted).unwrap();
        let returned =
            prorata_out(vault_balance + deposit_raw, minted, supply + minted_u64).unwrap();

        assert!(returned <= deposit_raw);
        assert!(
            deposit_raw - returned <= 2,
            "value leaked with fees disabled: deposited {deposit_raw}, got back {returned}"
        );
    }

    /// A redeemer must never be able to extract more than their share by
    /// splitting one redeem into many. Rounding down at every leg is what makes
    /// this hold.
    #[test]
    fn splitting_a_redeem_never_beats_doing_it_at_once() {
        let supply: u64 = 1_000_000_000_000;
        let balance: u64 = 777_777_777;
        let burn: u128 = 100_000_000_000; // 10% of supply

        let at_once = prorata_out(balance, burn, supply).unwrap();

        // Ten equal slices, each against the shrinking pool.
        let mut remaining_balance = balance;
        let mut remaining_supply = supply;
        let mut total = 0u64;
        for _ in 0..10 {
            let slice = burn / 10;
            let out = prorata_out(remaining_balance, slice, remaining_supply).unwrap();
            total += out;
            remaining_balance -= out;
            remaining_supply -= slice as u64;
        }

        assert!(
            total <= at_once,
            "splitting extracted more ({total}) than one redeem ({at_once})"
        );
    }

    #[test]
    fn weight_is_measured_in_units() {
        assert_eq!(
            weight_bps(4 * UNITS_SCALE, 10 * UNITS_SCALE).unwrap(),
            4_000
        );
        assert_eq!(weight_bps(0, 10 * UNITS_SCALE).unwrap(), 0);
        assert_eq!(weight_bps(5, 0).unwrap(), 0);
    }
}
