use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::errors::QuorumError;
use crate::nav::{breaker_check, compute_nav};
use crate::oracle::read_underlying_price;
use crate::state::*;

/// Recompute NAV, emit the per-issuer breakdown, and run the circuit breaker.
///
/// Permissionless: it moves no funds and can only restrict. Mint and redeem
/// compute NAV inline rather than depending on this having been called, since
/// no user action waits on a keeper (invariant 7 in `README.md`). It exists so
/// the dashboard and the bots can publish a fresh number on-chain.
///
/// Pass `remaining_accounts` as one triple per registered wrapper, in registry
/// order: `(wrapper_config, vault_token_account, wrapper_mint)`.
#[derive(Accounts)]
pub struct UpdateNav<'info> {
    #[account(mut, seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(address = vault.index_mint @ QuorumError::WrapperAccountMismatch)]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pyth price update for the underlying asset. The feed id is checked
    /// against `vault.underlying_feed_id` inside `read_underlying_price`, so a
    /// caller cannot substitute a friendlier feed.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
}

/// Emitted on every NAV update so the dashboard can render the per-issuer split
/// and the bots can watch for drift without re-deriving anything.
#[event]
pub struct NavUpdated {
    pub vault: Pubkey,
    pub nav_total: u128,
    pub nav_per_token: u128,
    pub total_units: u128,
    pub index_supply: u64,
    pub unit_price: u128,
    pub oracle_conf_bps: u64,
    pub oracle_publish_time: i64,
    pub breaker_tripped: bool,
}

pub fn update_nav<'info>(ctx: Context<'_, '_, 'info, 'info, UpdateNav<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();

    let price = read_underlying_price(&ctx.accounts.price_update, &ctx.accounts.vault, &clock)?;

    let nav = compute_nav(
        &ctx.accounts.vault,
        &vault_key,
        &price,
        ctx.accounts.index_mint.supply,
        ctx.remaining_accounts,
        ctx.program_id,
        clock.unix_timestamp,
    )?;

    let vault = &mut ctx.accounts.vault;

    let tripped = breaker_check(vault, nav.nav_per_token, clock.unix_timestamp);

    for c in &nav.contributions {
        msg!(
            "wrapper {} raw={} units={} haircut_bps={}",
            c.wrapper_mint,
            c.raw_balance,
            c.units,
            c.haircut_bps
        );
    }

    vault.nav_per_token = nav.nav_per_token;
    vault.nav_total = nav.nav_total;
    vault.nav_updated_slot = clock.slot;
    vault.nav_updated_ts = clock.unix_timestamp;

    if tripped {
        // Restrict only. The breaker pauses; it never moves funds, and
        // unpausing needs the full authority multisig (invariant 6).
        vault.status = VaultStatus::Paused;
        msg!("NAV circuit breaker tripped: vault PAUSED pending guardian review");
    }

    emit!(NavUpdated {
        vault: vault_key,
        nav_total: nav.nav_total,
        nav_per_token: nav.nav_per_token,
        total_units: nav.total_units,
        index_supply: nav.index_supply,
        unit_price: price.price_fp,
        oracle_conf_bps: price.conf_bps,
        oracle_publish_time: price.publish_time,
        breaker_tripped: tripped,
    });

    Ok(())
}
