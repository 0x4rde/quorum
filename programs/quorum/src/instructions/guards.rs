use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::depeg::{classify, implied_price_live, read_deviation_ema, DepegVerdict};
use crate::errors::QuorumError;
use crate::oracle::{map_pyth_err, read_underlying_ema, require_conf_within, to_price_fp};
use crate::state::*;

// ---------------------------------------------------------------------------
// Guardian: restrict only
// ---------------------------------------------------------------------------

/// Invariant 6 (`README.md`): the guardian can only restrict. No instruction
/// here lets the guardian move, withdraw or redirect a token, so its whole
/// vocabulary is "stop" and "quarantine".
#[derive(Accounts)]
pub struct GuardianAction<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol_seed()],
        bump = vault.bump,
        constraint = signer.key() == vault.guardian || signer.key() == vault.authority
            @ QuorumError::NotGuardian,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

#[event]
pub struct VaultPausedEvent {
    pub vault: Pubkey,
    pub by: Pubkey,
    pub previous_status: u8,
}

pub fn pause(ctx: Context<GuardianAction>) -> Result<()> {
    let previous = ctx.accounts.vault.status;
    ctx.accounts.vault.status = VaultStatus::Paused;
    emit!(VaultPausedEvent {
        vault: ctx.accounts.vault.key(),
        by: ctx.accounts.signer.key(),
        previous_status: previous as u8,
    });
    msg!("vault paused; in-kind redeem remains open");
    Ok(())
}

/// Flip in and out of MARKET_CLOSED. The guardian may only close; re-opening
/// belongs to the authority.
///
/// Nothing on-chain can prove the market is shut, so this flag only applies
/// the surcharge and tells the UI what to say. The real protection is the
/// `max_age` staleness check.
pub fn set_market_closed(ctx: Context<GuardianAction>, closed: bool) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    if closed {
        require!(
            !matches!(vault.status, VaultStatus::Paused),
            QuorumError::VaultPaused
        );
        vault.status = VaultStatus::MarketClosed;
    } else {
        require!(
            ctx.accounts.signer.key() == vault.authority,
            QuorumError::NotAuthority
        );
        require!(
            matches!(vault.status, VaultStatus::MarketClosed),
            QuorumError::VaultPaused
        );
        vault.status = VaultStatus::Active;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Authority: the only direction that relaxes
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AuthorityAction<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol_seed()],
        bump = vault.bump,
        constraint = authority.key() == vault.authority @ QuorumError::NotAuthority,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

/// `Quorum_Spec_v5.pdf` §9.2: "Unpausing needs the full authority multisig."
/// The guardian cannot reach this instruction at all.
pub fn unpause(ctx: Context<AuthorityAction>) -> Result<()> {
    ctx.accounts.vault.status = VaultStatus::Active;
    msg!("vault unpaused by authority");
    Ok(())
}

#[derive(Accounts)]
pub struct SetWrapperStatus<'info> {
    pub signer: Signer<'info>,

    #[account(seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_config.wrapper_mint.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,
}

#[event]
pub struct WrapperStatusChanged {
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    pub from: u8,
    pub to: u8,
    pub by: Pubkey,
    pub automatic: bool,
}

/// Change a wrapper's status manually.
///
/// Tightening, from Active through MintDisabled and Quarantined to Frozen, is
/// available to the guardian. Loosening in any direction requires the
/// authority (invariant 6).
pub fn set_wrapper_status(ctx: Context<SetWrapperStatus>, status: WrapperStatus) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let signer = ctx.accounts.signer.key();
    let is_authority = signer == vault.authority;
    let is_guardian = signer == vault.guardian;
    require!(is_authority || is_guardian, QuorumError::NotGuardian);

    let current = ctx.accounts.wrapper_config.status;
    let severity = |s: WrapperStatus| s.severity();

    if severity(status) < severity(current) {
        require!(is_authority, QuorumError::GuardianCannotDoThis);
    }

    ctx.accounts.wrapper_config.status = status;
    if matches!(status, WrapperStatus::Quarantined) && ctx.accounts.wrapper_config.haircut_bps == 0
    {
        ctx.accounts.wrapper_config.haircut_bps = DEFAULT_HAIRCUT_BPS;
    }
    if matches!(status, WrapperStatus::Active) {
        ctx.accounts.wrapper_config.depeg_since_ts = 0;
        ctx.accounts.wrapper_config.depeg_direction = 0;
        ctx.accounts.wrapper_config.haircut_bps = 0;
    }

    emit!(WrapperStatusChanged {
        vault: vault.key(),
        wrapper_mint: ctx.accounts.wrapper_config.wrapper_mint,
        from: severity(current),
        to: severity(status),
        by: signer,
        automatic: false,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Permissionless depeg check
// ---------------------------------------------------------------------------

/// Evaluate a wrapper's deviation and apply the guard table (spec §9.2).
///
/// Permissionless, because it can only restrict: the worst a caller can do is
/// quarantine a wrapper that genuinely is 5% off peg. Clearing a depeg back to
/// Active needs the authority, because a price briefly returning to fair value
/// is not evidence the issuer is fixed.
#[derive(Accounts)]
pub struct CheckDepeg<'info> {
    #[account(seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_config.wrapper_mint.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// Pyth price account for the underlying. The depeg test reads the
    /// averaged price inside it, not the spot tick, so both sides of the
    /// comparison are averaged alike.
    pub underlying_price_update: Box<Account<'info, PriceUpdateV2>>,
    /// The wrapper mint, so fair value includes its live Scaled UI multiplier.
    #[account(address = wrapper_config.wrapper_mint @ QuorumError::WrapperAccountMismatch)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Pyth price account for the wrapper itself. `Quorum_Spec_v5.pdf` §9.1
    /// rules out the spot tick, so the averaged price inside it is what gets
    /// compared and one sandwiched block cannot fake a depeg. Only some
    /// wrappers have a feed; those that do not cannot be checked on-chain.
    pub wrapper_price_update: Box<Account<'info, PriceUpdateV2>>,
}

#[event]
pub struct DepegChecked {
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    pub dev_bps: i64,
    pub dex_price: u128,
    pub implied_price: u128,
    pub verdict: u8,
    pub status_after: u8,
}

pub fn check_depeg(ctx: Context<CheckDepeg>) -> Result<()> {
    let clock = Clock::get()?;
    let underlying_fp = read_underlying_ema(
        &ctx.accounts.underlying_price_update,
        &ctx.accounts.vault,
        &clock,
    )?;
    let implied_fp = {
        let mint_ai = ctx.accounts.wrapper_mint.to_account_info();
        let data = mint_ai.try_borrow_data()?;
        implied_price_live(
            &ctx.accounts.wrapper_config,
            &data,
            clock.unix_timestamp,
            underlying_fp,
        )?
    };

    let dev = read_deviation_ema(
        &ctx.accounts.wrapper_config,
        &ctx.accounts.vault,
        &ctx.accounts.wrapper_price_update,
        implied_fp,
        &clock,
    )?;

    let vault = &ctx.accounts.vault;
    let verdict = classify(
        dev.dev_bps,
        ctx.accounts.wrapper_config.depeg_since_ts,
        ctx.accounts.wrapper_config.depeg_direction,
        clock.unix_timestamp,
        vault.soft_depeg_bps,
        vault.hard_depeg_bps,
        vault.min_depeg_duration_seconds,
    );

    let wrapper = &mut ctx.accounts.wrapper_config;
    let direction: i8 = if dev.dev_bps >= 0 { 1 } else { -1 };

    match verdict {
        DepegVerdict::Healthy => {
            // Stop the clock, but do NOT un-restrict. A wrapper that has been
            // quarantined stays quarantined until a human looks at it.
            wrapper.depeg_since_ts = 0;
            wrapper.depeg_direction = 0;
        }
        DepegVerdict::Watching => {
            if wrapper.depeg_since_ts == 0 || wrapper.depeg_direction != direction {
                wrapper.depeg_since_ts = clock.unix_timestamp;
                wrapper.depeg_direction = direction;
            }
        }
        // Both writes go through escalate(), which never lowers severity: this
        // instruction is permissionless, and a frozen leg must stay frozen
        // whatever the feed says.
        DepegVerdict::SoftDepeg => {
            wrapper.escalate(WrapperStatus::MintDisabled);
        }
        DepegVerdict::HardDepeg => {
            wrapper.escalate(WrapperStatus::Quarantined);
            wrapper.depeg_since_ts = clock.unix_timestamp;
            wrapper.depeg_direction = direction;
        }
    }

    emit!(DepegChecked {
        vault: vault.key(),
        wrapper_mint: wrapper.wrapper_mint,
        dev_bps: dev.dev_bps,
        dex_price: dev.dex_price_fp,
        implied_price: dev.implied_fp,
        verdict: verdict as u8,
        status_after: wrapper.status as u8,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Permissionless: cross-check the multiplier against Pyth's redemption rate
// ---------------------------------------------------------------------------

/// Verify the mint's Scaled UI multiplier against Pyth's redemption-rate
/// feed, which is invariant 5 made observable at runtime.
///
/// `register_wrapper` checks the extension set once at admission. This catches
/// the multiplier itself drifting wrong afterwards, which reverts nothing.
/// Permissionless, because it can only restrict.
#[derive(Accounts)]
pub struct VerifyRedemptionRate<'info> {
    #[account(seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_config.wrapper_mint.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// The wrapper mint, for its Scaled UI multiplier.
    #[account(address = wrapper_config.wrapper_mint @ QuorumError::WrapperAccountMismatch)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pyth `.RR` update for this wrapper.
    pub rr_price_update: Box<Account<'info, PriceUpdateV2>>,
}

#[event]
pub struct RedemptionRateChecked {
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    /// units_per_token x the mint's live multiplier, at UNIT_SCALE.
    pub on_chain_units: u128,
    /// Pyth's redemption rate, at UNIT_SCALE.
    pub pyth_units: u128,
    pub divergence_bps: u64,
    pub quarantined: bool,
}

pub fn verify_redemption_rate(ctx: Context<VerifyRedemptionRate>) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        ctx.accounts.wrapper_config.has_rr_feed,
        QuorumError::NoRedemptionRateFeed
    );

    let rr = ctx
        .accounts
        .rr_price_update
        .get_price_no_older_than(
            &clock,
            ctx.accounts.vault.max_age_seconds,
            &ctx.accounts.wrapper_config.rr_feed_id,
        )
        .map_err(map_pyth_err)?;
    require!(rr.price > 0, QuorumError::OracleInvalidPrice);

    // Pyth's answer, normalised to UNIT_SCALE. A wide-confidence print must not
    // be allowed to quarantine anything.
    let pyth_units = to_price_fp(rr.price as u64, rr.exponent)?;
    let rr_conf = to_price_fp(rr.conf, rr.exponent)?;
    require_conf_within(pyth_units, rr_conf, ctx.accounts.vault.max_conf_bps)?;

    // Taken through the same path NAV uses, so if NAV is wrong this is wrong
    // the same way and the comparison catches it.
    let mint_ai = ctx.accounts.wrapper_mint.to_account_info();
    let one_token = 10u64
        .checked_pow(ctx.accounts.wrapper_config.decimals as u32)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    let on_chain_units = {
        let data = mint_ai.try_borrow_data()?;
        crate::units::wrapper_units(
            &ctx.accounts.wrapper_config,
            one_token,
            &data,
            clock.unix_timestamp,
        )?
    };

    let divergence = crate::depeg::rr_divergence_bps(on_chain_units, pyth_units)?;
    let too_far = divergence > MAX_RR_DIVERGENCE_BPS;

    let wrapper = &mut ctx.accounts.wrapper_config;
    wrapper.last_rr = pyth_units;
    wrapper.last_rr_ts = clock.unix_timestamp;

    if too_far {
        // Restrict only. There is no attempt to "correct" units_per_token from
        // the oracle: when the two disagree, which one is right is not known,
        // and writing the vault's accounting from a feed on that basis would
        // fail far worse than stopping.
        wrapper.escalate(WrapperStatus::Quarantined);
        msg!(
            "QUARANTINE: mint multiplier and Pyth redemption rate differ by {}bps (limit {})",
            divergence,
            MAX_RR_DIVERGENCE_BPS
        );
    }

    emit!(RedemptionRateChecked {
        vault: ctx.accounts.vault.key(),
        wrapper_mint: wrapper.wrapper_mint,
        on_chain_units,
        pyth_units,
        divergence_bps: divergence,
        quarantined: too_far,
    });
    Ok(())
}
