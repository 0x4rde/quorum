//! NAV computation (`Quorum_Spec_v5.pdf` §5).
//!
//! ```text
//! wrapper_units_i = balance_i * units_per_token_i * (1 - haircut_i)
//! total_units     = sum(wrapper_units_i)
//! NAV_total       = total_units * unit_price
//! nav_per_token   = NAV_total / index_supply
//! ```
//!
//! The risk is completeness, not arithmetic: the accounts for that sum are
//! caller-supplied, and omitting one understates `total_units`, which
//! understates `nav_per_token`, which makes the next mint issue too many index
//! tokens. So nothing here iterates over what the caller passed. It iterates
//! over `vault.wrappers` and requires slot `i` of the registry to match the
//! triple at position `i` of the caller's list. That is invariant 3
//! (`README.md`) applied to reads rather than to swaps.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::constants::*;
use crate::errors::QuorumError;
use crate::oracle::OraclePrice;
use crate::state::{Vault, WrapperConfig, WrapperStatus};
use crate::units::{apply_haircut, wrapper_units};

/// What one wrapper contributes to NAV, for logging and the UI's per-issuer
/// split (spec §3).
#[derive(Clone, Copy, Debug)]
pub struct WrapperContribution {
    pub wrapper_mint: Pubkey,
    /// Raw token-account balance, before decimals or multiplier.
    pub raw_balance: u64,
    /// Underlying units at `UNITS_SCALE`, after multiplier, before haircut. The
    /// permissionless bounds compare on this, so a quarantined wrapper's
    /// haircut cannot disguise a sale below fair value.
    pub gross_units: u128,
    /// Underlying units at `UNITS_SCALE`, after multiplier and haircut.
    pub units: u128,
    pub haircut_bps: u16,
}

#[derive(Clone, Debug)]
pub struct Nav {
    /// Underlying units across the whole basket, at `UNITS_SCALE`, haircut.
    pub total_units: u128,
    /// The same sum before any haircut. What the basket physically holds.
    pub total_gross_units: u128,
    /// Total vault value in USD at `NAV_SCALE`.
    pub nav_total: u128,
    /// USD per whole index token at `NAV_SCALE`. Zero when supply is zero.
    pub nav_per_token: u128,
    pub index_supply: u64,
    /// True while any wrapper is Quarantined or Frozen, which makes NAV a
    /// discounted number. The mint paths refuse non-authority deposits while
    /// it is set, so nobody can buy the discount and hold it until the
    /// wrapper is restored.
    pub any_impaired: bool,
    pub contributions: Vec<WrapperContribution>,
}

/// One registered wrapper, with every account the caller passed for it
/// validated against the on-chain registry.
pub struct RegistryLeg<'info> {
    pub wrapper: Account<'info, WrapperConfig>,
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_ai: &'info AccountInfo<'info>,
    pub mint_ai: &'info AccountInfo<'info>,
    /// The `stride - 3` accounts after the standard triple, for callers that
    /// pass more per leg (redeem passes the user's receiving account).
    pub extra: &'info [AccountInfo<'info>],
}

/// Validate `remaining` against `vault.wrappers` and hand back one leg per
/// registered wrapper, in registry order.
///
/// The single place caller-supplied wrapper accounts are trusted from, for
/// NAV and for redeem alike. It re-derives each config PDA rather than
/// trusting the key passed, so a short, reordered, duplicated or substituted
/// list fails.
pub fn walk_registry<'info>(
    vault: &Vault,
    vault_key: &Pubkey,
    program_id: &Pubkey,
    remaining: &'info [AccountInfo<'info>],
    stride: usize,
) -> Result<Vec<RegistryLeg<'info>>> {
    debug_assert!(stride >= 3);
    let n = vault.wrapper_count as usize;
    require!(
        remaining.len() == n * stride,
        QuorumError::IncompleteWrapperAccounts
    );

    let mut legs = Vec::with_capacity(n);
    for i in 0..n {
        let registered_mint = vault.wrappers[i];
        let chunk = &remaining[i * stride..(i + 1) * stride];
        let (cfg_ai, token_ai, mint_ai, extra) = (&chunk[0], &chunk[1], &chunk[2], &chunk[3..]);

        // Checking the derivation rather than the passed key is what makes
        // substitution fail.
        let (expected_cfg, _) = Pubkey::find_program_address(
            &[WRAPPER_SEED, vault_key.as_ref(), registered_mint.as_ref()],
            program_id,
        );
        require_keys_eq!(
            cfg_ai.key(),
            expected_cfg,
            QuorumError::WrapperAccountMismatch
        );

        let wrapper: Account<'info, WrapperConfig> = Account::try_from(cfg_ai)?;
        require_keys_eq!(
            wrapper.vault,
            *vault_key,
            QuorumError::WrapperAccountMismatch
        );
        require_keys_eq!(
            wrapper.wrapper_mint,
            registered_mint,
            QuorumError::WrapperAccountMismatch
        );
        require_keys_eq!(
            token_ai.key(),
            wrapper.vault_token_account,
            QuorumError::WrapperAccountMismatch
        );
        require_keys_eq!(
            mint_ai.key(),
            wrapper.wrapper_mint,
            QuorumError::WrapperAccountMismatch
        );

        let token_account: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(token_ai)?;
        legs.push(RegistryLeg {
            wrapper,
            token_account,
            token_ai,
            mint_ai,
            extra,
        });
    }
    Ok(legs)
}

/// Walk the registry and value the basket.
///
/// `remaining` must be exactly `3 * wrapper_count` accounts, grouped as
/// `(wrapper_config, vault_token_account, wrapper_mint)` and ordered to match
/// `vault.wrappers`.
pub fn compute_nav<'info>(
    vault: &Vault,
    vault_key: &Pubkey,
    price: &OraclePrice,
    index_supply: u64,
    remaining: &'info [AccountInfo<'info>],
    program_id: &Pubkey,
    now_ts: i64,
) -> Result<Nav> {
    let legs = walk_registry(vault, vault_key, program_id, remaining, 3)?;

    let mut total_units: u128 = 0;
    let mut total_gross_units: u128 = 0;
    let mut any_impaired = false;
    let mut contributions = Vec::with_capacity(legs.len());

    for leg in &legs {
        any_impaired |= matches!(
            leg.wrapper.status,
            WrapperStatus::Quarantined | WrapperStatus::Frozen
        );
        let raw_balance = leg.token_account.amount;

        // Invariant 5 lives inside `wrapper_units`.
        let mint_data = leg.mint_ai.try_borrow_data()?;
        let gross = wrapper_units(&leg.wrapper, raw_balance, &mint_data, now_ts)?;
        drop(mint_data);

        // Quarantined counts at a discount, frozen counts as zero. Neither is
        // removed from the balance sheet.
        let haircut_bps = leg.wrapper.nav_haircut_bps();
        let units = apply_haircut(gross, haircut_bps)?;

        total_units = total_units
            .checked_add(units)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;
        total_gross_units = total_gross_units
            .checked_add(gross)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;

        contributions.push(WrapperContribution {
            wrapper_mint: leg.wrapper.wrapper_mint,
            raw_balance,
            gross_units: gross,
            units,
            haircut_bps,
        });
    }

    // Both operands carry a scale, so divide once to land back at NAV_SCALE.
    // The vault holds nothing but wrappers. There is no cash buffer, so
    // there is no unpriced balance for this sum to omit.
    let nav_total = total_units
        .checked_mul(price.price_fp)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / UNITS_SCALE;

    // Supply zero is the pre-seed state, not an error, so callers that divide
    // by nav_per_token must handle the zero.
    let nav_per_token = if index_supply == 0 {
        0
    } else {
        nav_total
            .checked_mul(10u128.pow(INDEX_DECIMALS as u32))
            .ok_or_else(|| error!(QuorumError::MathOverflow))?
            / index_supply as u128
    };

    Ok(Nav {
        total_units,
        total_gross_units,
        nav_total,
        nav_per_token,
        index_supply,
        any_impaired,
        contributions,
    })
}

/// Test spec §9.2's circuit breaker against the stored anchor, returning
/// whether it tripped. Every path that values the basket calls this.
///
/// The anchor is held until the window elapses, so the test is "8% against a
/// point up to 10 minutes back" rather than "8% between two adjacent calls",
/// which a move delivered in small steps would pass. An anchor older than the
/// window is re-seeded and the caller allowed through, because a quiet keeper
/// must not block a user action.
pub fn breaker_check(vault: &mut Vault, current_nav_per_token: u128, now_ts: i64) -> bool {
    let window = vault.nav_breaker_window_seconds;
    let stale = vault.nav_anchor_ts == 0 || now_ts.saturating_sub(vault.nav_anchor_ts) > window;
    if stale {
        vault.nav_anchor_per_token = current_nav_per_token;
        vault.nav_anchor_ts = now_ts;
        return false;
    }
    nav_move_exceeds(
        vault.nav_anchor_per_token,
        vault.nav_anchor_ts,
        current_nav_per_token,
        now_ts,
        vault.nav_breaker_bps,
        window,
    )
}

/// Spec §9.2: NAV moving more than `bps` inside `window_seconds` trips a global
/// pause for guardian review.
///
/// Returns true when the move is out of bounds. A zero previous NAV (first
/// observation, or an empty vault) cannot produce a meaningful percentage, so
/// it never trips.
pub fn nav_move_exceeds(
    previous: u128,
    previous_ts: i64,
    current: u128,
    now_ts: i64,
    bps: u16,
    window_seconds: i64,
) -> bool {
    if previous == 0 || previous_ts == 0 {
        return false;
    }
    if now_ts.saturating_sub(previous_ts) > window_seconds {
        return false;
    }
    let delta = current.abs_diff(previous);
    let move_bps = delta.saturating_mul(BPS_DENOM as u128) / previous;
    move_bps > bps as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with_breaker() -> Vault {
        Vault {
            nav_breaker_bps: 800,
            nav_breaker_window_seconds: 600,
            ..Default::default()
        }
    }

    /// The first observation has nothing to compare against, so it seeds the
    /// anchor instead of tripping.
    #[test]
    fn breaker_check_seeds_its_anchor() {
        let mut v = vault_with_breaker();
        assert!(!breaker_check(&mut v, 100 * PRICE_SCALE, 1_000));
        assert_eq!(v.nav_anchor_per_token, 100 * PRICE_SCALE);
        assert_eq!(v.nav_anchor_ts, 1_000);
    }

    /// A 10% drop delivered in four 2.5% steps passes a check that compares
    /// adjacent observations. Against a held anchor it trips on the step that
    /// crosses 8%.
    #[test]
    fn breaker_catches_a_move_split_across_several_observations() {
        let mut v = vault_with_breaker();
        assert!(!breaker_check(&mut v, 100 * PRICE_SCALE, 1_000));
        assert!(!breaker_check(&mut v, 975 * PRICE_SCALE / 10, 1_100));
        assert!(!breaker_check(&mut v, 95 * PRICE_SCALE, 1_200));
        assert!(!breaker_check(&mut v, 925 * PRICE_SCALE / 10, 1_300));
        // 100 -> 90 is 10%, past the 8% bound, and still inside the window.
        assert!(breaker_check(&mut v, 90 * PRICE_SCALE, 1_400));
        // The anchor did not drift while all this was happening.
        assert_eq!(v.nav_anchor_per_token, 100 * PRICE_SCALE);
    }

    /// Once the window has passed the old anchor is not evidence about now, so
    /// it is replaced and the caller is let through.
    #[test]
    fn breaker_reseeds_after_the_window() {
        let mut v = vault_with_breaker();
        assert!(!breaker_check(&mut v, 100 * PRICE_SCALE, 1_000));
        assert!(!breaker_check(&mut v, 50 * PRICE_SCALE, 1_000 + 601));
        assert_eq!(v.nav_anchor_per_token, 50 * PRICE_SCALE);
    }

    #[test]
    fn breaker_trips_past_threshold_inside_window() {
        // 10% move, 8% threshold, 2 min into a 10 min window
        assert!(nav_move_exceeds(1_000, 100, 1_100, 220, 800, 600));
    }

    #[test]
    fn breaker_ignores_moves_outside_the_window() {
        // Same 10% move, but 20 minutes later: that is drift, not a shock.
        assert!(!nav_move_exceeds(1_000, 100, 1_100, 1_400, 800, 600));
    }

    #[test]
    fn breaker_tolerates_moves_under_threshold() {
        assert!(!nav_move_exceeds(1_000, 100, 1_050, 200, 800, 600));
    }

    #[test]
    fn breaker_is_symmetric() {
        assert!(nav_move_exceeds(1_000, 100, 890, 200, 800, 600));
    }

    #[test]
    fn breaker_never_trips_on_a_cold_start() {
        assert!(!nav_move_exceeds(0, 0, 5_000, 200, 800, 600));
    }
}
