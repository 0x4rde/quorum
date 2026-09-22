use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::economics::{apply_fee, gross_index_for_deposit, weight_bps};
use crate::errors::QuorumError;
use crate::nav::{breaker_check, compute_nav};
use crate::oracle::read_underlying_price;
use crate::state::*;
use crate::units::wrapper_units;

/// In-kind mint (`Quorum_Spec_v5.pdf` §6.1). Deposit one whitelisted wrapper,
/// receive index tokens. No swap, no slippage, no route.
///
/// NAV is computed before the deposit lands: pricing a deposit against a NAV
/// that already includes it is circular.
///
/// `remaining_accounts` are the NAV triples for every registered wrapper, in
/// registry order, as `update_nav` takes them.
#[derive(Accounts)]
pub struct MintInKind<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    #[account(address = wrapper_config.wrapper_mint @ QuorumError::WrapperAccountMismatch)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        address = wrapper_config.vault_token_account @ QuorumError::WrapperAccountMismatch,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_wrapper_account.mint == wrapper_config.wrapper_mint @ QuorumError::InputMintNotAllowed,
    )]
    pub user_wrapper_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = vault.index_mint @ QuorumError::WrapperAccountMismatch)]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = user_index_account.mint == vault.index_mint @ QuorumError::WrapperAccountMismatch,
    )]
    pub user_index_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    /// Token program owning the wrapper mint (SPL or Token-2022).
    pub wrapper_token_program: Interface<'info, TokenInterface>,
    /// Token program owning the index mint. Always Token-2022.
    pub index_token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct MintedInKind {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub wrapper_mint: Pubkey,
    pub deposit_requested: u64,
    pub deposit_measured: u64,
    pub units_credited: u128,
    pub index_minted: u64,
    pub fee_bps: u16,
    pub nav_per_token_used: u128,
}

pub fn mint_in_kind<'info>(
    ctx: Context<'_, '_, 'info, 'info, MintInKind<'info>>,
    amount: u64,
    min_index_out: u64,
) -> Result<()> {
    require!(amount > 0, QuorumError::ZeroMintAmount);

    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();

    // PAUSED doubles as the pre-launch seeding window: the authority may
    // deposit, nobody else can, and the issuer cap is skipped below. It has to
    // be, because the first deposit into an empty vault is 100% of one issuer.
    // MARKET_CLOSED does not block deposits, which carry no execution risk.
    let seeding = matches!(ctx.accounts.vault.status, VaultStatus::Paused);
    if seeding {
        require_keys_eq!(
            ctx.accounts.user.key(),
            ctx.accounts.vault.authority,
            QuorumError::VaultPaused
        );
    }

    // Spec §9.2: a wrapper on MINT_DISABLED (soft depeg) takes no new deposits,
    // and a QUARANTINED one certainly does not.
    ctx.accounts.wrapper_config.require_mintable()?;

    let price = read_underlying_price(&ctx.accounts.price_update, &ctx.accounts.vault, &clock)?;

    // --- NAV before the deposit ---
    let nav_before = compute_nav(
        &ctx.accounts.vault,
        &vault_key,
        &price,
        ctx.accounts.index_mint.supply,
        ctx.remaining_accounts,
        ctx.program_id,
        clock.unix_timestamp,
    )?;

    // While any wrapper is impaired NAV is discounted, and a mint priced
    // against it would cash out at full value once the authority restores the
    // wrapper, at everyone else's expense. A guardian key can open that window
    // on demand, so it is closed to everyone but the authority.
    if nav_before.any_impaired {
        require_keys_eq!(
            ctx.accounts.user.key(),
            ctx.accounts.vault.authority,
            QuorumError::VaultImpaired
        );
    }

    // Spec §9.2's breaker, on the path that matters: a mint can land before
    // anyone calls update_nav. Refuse rather than pause, because pausing is
    // the guardian's call.
    require!(
        !breaker_check(
            &mut ctx.accounts.vault,
            nav_before.nav_per_token,
            clock.unix_timestamp
        ),
        QuorumError::NavCircuitBreaker
    );

    // Invariant 2 (`README.md`), even here where there is no route: PAXG
    // carries a TransferFeeConfig whose authority can raise it above zero at
    // any time, so credit the measured delta, not the requested amount.
    let balance_before = ctx.accounts.vault_token_account.amount;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.wrapper_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wrapper_account.to_account_info(),
                mint: ctx.accounts.wrapper_mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.wrapper_mint.decimals,
    )?;

    ctx.accounts.vault_token_account.reload()?;
    let balance_after = ctx.accounts.vault_token_account.amount;
    let measured = balance_after
        .checked_sub(balance_before)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    require!(measured > 0, QuorumError::ZeroMintAmount);

    // --- Value the measured deposit ---
    let mint_ai = ctx.accounts.wrapper_mint.to_account_info();
    let mint_data = mint_ai.try_borrow_data()?;
    let deposit_units = wrapper_units(
        &ctx.accounts.wrapper_config,
        measured,
        &mint_data,
        clock.unix_timestamp,
    )?;
    drop(mint_data);
    require!(deposit_units > 0, QuorumError::ZeroMintAmount);

    let deposit_value = deposit_units
        .checked_mul(price.price_fp)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        / UNITS_SCALE;

    // Issuer cap (spec §9.2). Skipped only while seeding; once the vault is
    // live it binds on the authority too.
    if !seeding {
        let existing_units = nav_before
            .contributions
            .iter()
            .find(|c| c.wrapper_mint == ctx.accounts.wrapper_config.wrapper_mint)
            .map(|c| c.units)
            .unwrap_or(0);

        let wrapper_units_after = existing_units
            .checked_add(deposit_units)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;
        let total_units_after = nav_before
            .total_units
            .checked_add(deposit_units)
            .ok_or_else(|| error!(QuorumError::MathOverflow))?;

        let w = weight_bps(wrapper_units_after, total_units_after)?;
        require!(
            w <= ctx.accounts.wrapper_config.max_weight_bps as u128,
            QuorumError::IssuerCapExceeded
        );
    }

    // The first mint bootstraps the rate at one index token per unit of
    // account; afterwards the rate is whatever NAV says.
    let gross_index = gross_index_for_deposit(
        nav_before.index_supply,
        deposit_units,
        deposit_value,
        nav_before.nav_per_token,
    )?;

    // The fee is withheld, not transferred: minting fewer tokens leaves the
    // difference in the vault and lifts NAV for existing holders (spec §10).
    //
    // Spec §10 puts the market-closed surcharge on the swap paths. The program
    // has none, so it attaches here instead: a deposit priced off a
    // last-known oracle carries more uncertainty than one during open hours,
    // and existing holders are the ones carrying it.
    let fee_bps = if matches!(ctx.accounts.vault.status, VaultStatus::MarketClosed) {
        ctx.accounts
            .vault
            .fee_mint_bps
            .saturating_add(ctx.accounts.vault.market_closed_surcharge_bps)
    } else {
        ctx.accounts.vault.fee_mint_bps
    };
    let net_index = apply_fee(gross_index, fee_bps)?;

    let net_index = u64::try_from(net_index).map_err(|_| error!(QuorumError::MathOverflow))?;
    require!(net_index > 0, QuorumError::ZeroMintAmount);
    require!(net_index >= min_index_out, QuorumError::SlippageExceeded);

    // --- Mint ---
    let signer = ctx.accounts.vault.signer();
    let seeds = signer.seeds();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.index_token_program.to_account_info(),
            token_interface::MintTo {
                mint: ctx.accounts.index_mint.to_account_info(),
                to: ctx.accounts.user_index_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[&seeds],
        ),
        net_index,
    )?;

    emit!(MintedInKind {
        vault: vault_key,
        user: ctx.accounts.user.key(),
        wrapper_mint: ctx.accounts.wrapper_config.wrapper_mint,
        deposit_requested: amount,
        deposit_measured: measured,
        units_credited: deposit_units,
        index_minted: net_index,
        fee_bps,
        nav_per_token_used: nav_before.nav_per_token,
    });

    Ok(())
}
