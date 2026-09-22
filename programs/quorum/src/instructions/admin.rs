//! Post-initialization configuration, all of it authority-only.
//!
//! Without these, a Pyth feed rotation would kill every path but redeem for
//! good, and the keeper-pushed `units_per_token` of `Quorum_Spec_v5.pdf` §8
//! would have no instruction to push it. One rule from that section is enforced
//! on-chain: a `units_per_token` move larger than 1% needs the guardian to
//! co-sign, which is what catches a bad keeper push or an unannounced split.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuorumError;
use crate::state::*;

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol_seed()],
        bump = vault.bump,
        constraint = authority.key() == vault.authority @ QuorumError::NotAuthority,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
    require_keys_neq!(
        new_authority,
        Pubkey::default(),
        QuorumError::InvalidParameter
    );
    ctx.accounts.vault.authority = new_authority;
    Ok(())
}

pub fn set_guardian(ctx: Context<AuthorityOnly>, new_guardian: Pubkey) -> Result<()> {
    ctx.accounts.vault.guardian = new_guardian;
    Ok(())
}

/// Every field optional; `None` leaves it alone. Ranges are checked the same
/// way `initialize_vault` checks them, so nothing here can brick a path.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct VaultConfigUpdate {
    pub underlying_feed_id: Option<[u8; 32]>,
    pub max_age_seconds: Option<u64>,
    pub max_conf_bps: Option<u16>,
    pub fee_mint_bps: Option<u16>,
    pub fee_redeem_bps: Option<u16>,
    pub market_closed_surcharge_bps: Option<u16>,
    pub nav_breaker_bps: Option<u16>,
    pub nav_breaker_window_seconds: Option<i64>,
    pub soft_depeg_bps: Option<u16>,
    pub hard_depeg_bps: Option<u16>,
    pub min_depeg_duration_seconds: Option<i64>,
    pub twap_window_seconds: Option<u64>,
    pub max_swap_bps: Option<u16>,
    pub swap_cooldown_seconds: Option<i64>,
    pub caller_reward_bps: Option<u16>,
    pub rebalance_drift_bps: Option<u16>,
    pub max_loss_bps: Option<u16>,
    pub min_gain_bps: Option<u16>,
}

pub fn update_vault_config(ctx: Context<AuthorityOnly>, u: VaultConfigUpdate) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    macro_rules! set {
        ($f:ident) => {
            if let Some(x) = u.$f {
                v.$f = x;
            }
        };
    }
    set!(underlying_feed_id);
    set!(max_age_seconds);
    set!(max_conf_bps);
    set!(fee_mint_bps);
    set!(fee_redeem_bps);
    set!(market_closed_surcharge_bps);
    set!(nav_breaker_bps);
    set!(nav_breaker_window_seconds);
    set!(soft_depeg_bps);
    set!(hard_depeg_bps);
    set!(min_depeg_duration_seconds);
    set!(twap_window_seconds);
    set!(max_swap_bps);
    set!(swap_cooldown_seconds);
    set!(caller_reward_bps);
    set!(rebalance_drift_bps);
    set!(max_loss_bps);
    set!(min_gain_bps);

    let bps = BPS_DENOM as u16;
    require!(
        v.fee_mint_bps < bps
            && v.fee_redeem_bps < bps
            && (v.fee_mint_bps as u64 + v.market_closed_surcharge_bps as u64) < BPS_DENOM
            && v.max_conf_bps <= bps
            && v.max_swap_bps <= bps
            && v.caller_reward_bps <= bps
            && v.max_loss_bps < bps
            && v.soft_depeg_bps > 0
            && v.hard_depeg_bps >= v.soft_depeg_bps
            && v.max_age_seconds > 0
            && v.twap_window_seconds > 0
            && v.nav_breaker_window_seconds > 0,
        QuorumError::InvalidParameter
    );
    // A new feed id invalidates the breaker anchor; it re-seeds itself.
    if u.underlying_feed_id.is_some() {
        v.nav_anchor_ts = 0;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateWrapperConfig<'info> {
    pub authority: Signer<'info>,
    /// Required only when `units_per_token` moves by more than
    /// `UNITS_PER_TOKEN_GUARDED_MOVE_BPS` (spec §8).
    pub guardian: Option<Signer<'info>>,

    #[account(
        seeds = [VAULT_SEED, vault.symbol_seed()],
        bump = vault.bump,
        constraint = authority.key() == vault.authority @ QuorumError::NotAuthority,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_config.wrapper_mint.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct WrapperConfigUpdate {
    /// The keeper-pushed multiplier for wrappers whose issuer does not encode
    /// corporate actions on the mint. Guarded by the 1% co-sign rule.
    pub units_per_token: Option<u128>,
    pub target_weight_bps: Option<u16>,
    pub max_weight_bps: Option<u16>,
    pub haircut_bps: Option<u16>,
    pub dex_price_source: Option<Pubkey>,
    pub wrapper_feed_id: Option<[u8; 32]>,
    pub has_wrapper_feed: Option<bool>,
    pub rr_feed_id: Option<[u8; 32]>,
    pub has_rr_feed: Option<bool>,
}

#[event]
pub struct UnitsPerTokenChanged {
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    pub from: u128,
    pub to: u128,
    pub move_bps: u64,
    pub guardian_cosigned: bool,
}

pub fn update_wrapper_config(
    ctx: Context<UpdateWrapperConfig>,
    u: WrapperConfigUpdate,
) -> Result<()> {
    let w = &mut ctx.accounts.wrapper_config;

    if let Some(new_upt) = u.units_per_token {
        require!(new_upt > 0, QuorumError::InvalidParameter);
        // A Scaled UI wrapper's multiplier lives on the mint; pushing one here
        // would double-count every dividend.
        require!(
            !matches!(w.multiplier_source, MultiplierSource::Token2022ScaledUi),
            QuorumError::ScaledUiConfigMismatch
        );
        let old = w.units_per_token;
        let move_bps = old
            .abs_diff(new_upt)
            .checked_mul(BPS_DENOM as u128)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?
            / old;
        let cosigned = ctx
            .accounts
            .guardian
            .as_ref()
            .is_some_and(|g| g.key() == ctx.accounts.vault.guardian);
        if move_bps > UNITS_PER_TOKEN_GUARDED_MOVE_BPS as u128 {
            require!(cosigned, QuorumError::UnitsPerTokenMoveNeedsGuardian);
        }
        w.units_per_token = new_upt;
        emit!(UnitsPerTokenChanged {
            vault: ctx.accounts.vault.key(),
            wrapper_mint: w.wrapper_mint,
            from: old,
            to: new_upt,
            move_bps: u64::try_from(move_bps).unwrap_or(u64::MAX),
            guardian_cosigned: cosigned,
        });
    }

    macro_rules! set {
        ($f:ident) => {
            if let Some(x) = u.$f {
                w.$f = x;
            }
        };
    }
    set!(target_weight_bps);
    set!(max_weight_bps);
    set!(haircut_bps);
    set!(dex_price_source);
    set!(wrapper_feed_id);
    set!(has_wrapper_feed);
    set!(rr_feed_id);
    set!(has_rr_feed);

    let bps = BPS_DENOM as u16;
    require!(
        w.target_weight_bps <= bps && w.max_weight_bps <= bps && w.haircut_bps <= bps,
        QuorumError::InvalidParameter
    );
    Ok(())
}
