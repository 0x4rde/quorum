//! Permissionless swaps: `swap_depegged` (`Quorum_Spec_v5.pdf` §9.1) and
//! `rebalance` (spec §7), each split into a loan and a settle.
//!
//! The vault signs no route anywhere in this program. It lends the source
//! tokens to the caller's own account and requires the proceeds back in the
//! same transaction. Signing a route directly would hand out a signature good
//! for every vault-owned account that route names, not only the declared leg,
//! and would then need every leg re-measured and checked for leftover
//! delegates afterwards:
//!
//! ```text
//! ix i      begin_rebalance | begin_swap_depegged    vault -> caller
//! ix i+1..  anything: one venue, several, or the caller's own inventory
//! ix k      end_swap                                 caller -> vault, bounds
//! ```
//!
//! What happens in between is not this program's business, because nothing in
//! between carries a vault signature. That removes a class of failure rather
//! than bounding it, lets the caller fill anywhere, and makes the path
//! testable without an aggregator.
//!
//! Atomicity alone does not make the loan safe: a transaction containing only
//! the loan still commits. So `begin_swap` proves by instruction
//! introspection that a matching settle runs later in the same transaction
//! and records the index it must run at. The ticket PDA carries the state and
//! stops a second concurrent loan; it is not the guarantee.
//!
//! What the settle enforces (invariant 4 in `README.md`):
//!
//! 1. The destination leg gained at least the floor, measured on gross units
//!    so a quarantined wrapper's haircut cannot disguise a bad fill.
//! 2. The basket as a whole did not fall below what that trade allows, which
//!    catches units leaving any other leg.
//! 3. The destination is still inside `max_weight_bps`, so nobody can be paid
//!    to concentrate the basket into one issuer.
//! 4. The source leg lost no more than was lent.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_lang::Discriminator;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::depeg::{classify, implied_price_live, read_deviation_ema, DepegVerdict};
use crate::economics::weight_bps;
use crate::errors::QuorumError;
use crate::nav::compute_nav;
use crate::oracle::{read_underlying_ema, read_underlying_price};
use crate::state::*;
use crate::units::wrapper_units;

/// Where `vault` sits in `SettleSwap`'s account list, for introspection.
const END_SWAP_VAULT_INDEX: usize = 1;

const KIND_REBALANCE: u8 = 0;
const KIND_DEPEGGED: u8 = 1;

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// The index of the top-level instruction currently executing, after checking
/// that it is this program's.
///
/// If another program invoked us by CPI, the instruction at the current index
/// is the caller's rather than ours, and everything read from the transaction
/// would be theirs to arrange. Refuse instead of reasoning about it.
fn current_top_level_index(ix_sysvar: &AccountInfo) -> Result<u16> {
    let index =
        load_current_index_checked(ix_sysvar).map_err(|_| error!(QuorumError::MustBeTopLevel))?;
    let current = load_instruction_at_checked(index as usize, ix_sysvar)
        .map_err(|_| error!(QuorumError::MustBeTopLevel))?;
    require_keys_eq!(current.program_id, crate::ID, QuorumError::MustBeTopLevel);
    Ok(index)
}

/// Find the settle that will close this loan and return the index it must run
/// at.
///
/// Matching the discriminator alone would let a caller point at a settle for
/// a different vault, so the vault key is checked at its known position in
/// the settle's account list. The index goes into the ticket and `end_swap`
/// asserts against it, which makes the pairing exact rather than merely
/// present.
fn find_settle(ix_sysvar: &AccountInfo, after: u16, vault: &Pubkey) -> Result<u16> {
    let mut i = after as usize + 1;
    while let Ok(ix) = load_instruction_at_checked(i, ix_sysvar) {
        let is_settle = ix.program_id == crate::ID
            && ix.data.len() >= 8
            && ix.data[..8] == *crate::instruction::EndSwap::DISCRIMINATOR
            && ix
                .accounts
                .get(END_SWAP_VAULT_INDEX)
                .is_some_and(|a| a.pubkey == *vault);
        if is_settle {
            return u16::try_from(i).map_err(|_| error!(QuorumError::MathOverflow));
        }
        i += 1;
    }
    Err(error!(QuorumError::MissingSettleInstruction))
}

// ---------------------------------------------------------------------------
// Loan
// ---------------------------------------------------------------------------

/// `remaining_accounts`: `3 * wrapper_count` NAV triples in registry order,
/// then, for `begin_swap_depegged` only, the underlying's Pyth price account
/// and the source wrapper's. The averaged price the depeg test compares
/// travels inside each of those, so no separate account is needed.
#[derive(Accounts)]
pub struct BeginSwap<'info> {
    /// Anyone. Pays the ticket rent and receives the loan.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// Fails while another loan on this vault is outstanding.
    #[account(
        init,
        payer = caller,
        space = SwapTicket::LEN,
        seeds = [SWAP_TICKET_SEED, vault.key().as_ref()],
        bump,
    )]
    pub ticket: Box<Account<'info, SwapTicket>>,

    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), source_wrapper.wrapper_mint.as_ref()],
        bump = source_wrapper.bump,
        constraint = source_wrapper.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub source_wrapper: Box<Account<'info, WrapperConfig>>,

    /// The wrapper being bought. Must be ACTIVE (spec §6.4, invariant 3).
    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), dest_wrapper.wrapper_mint.as_ref()],
        bump = dest_wrapper.bump,
        constraint = dest_wrapper.vault == vault.key() @ QuorumError::WrapperAccountMismatch,
    )]
    pub dest_wrapper: Box<Account<'info, WrapperConfig>>,

    #[account(
        mut,
        address = source_wrapper.vault_token_account @ QuorumError::WrapperAccountMismatch,
    )]
    pub source_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The caller's own account for the source wrapper. The loan lands here.
    #[account(
        mut,
        constraint = caller_source_account.mint == source_wrapper.wrapper_mint
            @ QuorumError::InputMintNotAllowed,
    )]
    pub caller_source_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = source_wrapper.wrapper_mint @ QuorumError::WrapperAccountMismatch)]
    pub source_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = vault.index_mint @ QuorumError::WrapperAccountMismatch)]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub source_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: pinned to the instructions sysvar by address.
    #[account(address = INSTRUCTIONS_ID @ QuorumError::MustBeTopLevel)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct SwapLoanOpened {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub kind: u8,
    pub source_wrapper: Pubkey,
    pub dest_wrapper: Pubkey,
    pub source_lent_raw: u64,
    pub source_gross_sold: u128,
    pub min_dest_gross: u128,
    pub settle_index: u16,
}

/// Checks that apply to both kinds before anything moves.
fn preflight(
    vault: &Vault,
    source: &WrapperConfig,
    dest: &WrapperConfig,
    now_ts: i64,
) -> Result<()> {
    require!(
        dest.allowed_as_swap_output(),
        QuorumError::OutputMintNotAllowed
    );
    require_keys_neq!(
        source.wrapper_mint,
        dest.wrapper_mint,
        QuorumError::InputMintNotAllowed
    );
    require!(
        now_ts.saturating_sub(vault.last_permissionless_swap_ts) >= vault.swap_cooldown_seconds,
        QuorumError::CooldownActive
    );
    Ok(())
}

/// `units_sold * (BPS_DENOM ± bps) / BPS_DENOM`, the floor a trade must clear.
fn floor_for(units_sold: u128, adjust_bps: i64) -> Result<u128> {
    let factor = (BPS_DENOM as i128 + adjust_bps as i128) as u128;
    units_sold
        .checked_mul(factor)
        .ok_or_else(|| error!(QuorumError::MathOverflow))
        .map(|v| v / BPS_DENOM as u128)
}

/// Lend the source tokens out, price what left, and open the ticket.
fn open_loan<'info>(
    ctx: &mut Context<'_, '_, 'info, 'info, BeginSwap<'info>>,
    nav_accounts: &'info [AccountInfo<'info>],
    amount: u64,
    kind: u8,
    adjust_bps: i64,
    clock: &Clock,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    require!(amount > 0, QuorumError::ZeroMintAmount);

    let price = read_underlying_price(&ctx.accounts.price_update, &ctx.accounts.vault, clock)?;
    let nav_before = compute_nav(
        &ctx.accounts.vault,
        &vault_key,
        &price,
        ctx.accounts.index_mint.supply,
        nav_accounts,
        ctx.program_id,
        clock.unix_timestamp,
    )?;

    // Spec §9.1: one call may move at most `max_swap_bps` of the leg.
    let balance_before = ctx.accounts.source_token_account.amount;
    let max_source: u64 = ((balance_before as u128) * ctx.accounts.vault.max_swap_bps as u128
        / BPS_DENOM as u128)
        .try_into()
        .map_err(|_| error!(QuorumError::MathOverflow))?;
    require!(amount <= max_source, QuorumError::SwapSizeExceeded);

    // The loan. The only vault signature on this path, and it signs a
    // transfer of the vault's own tokens rather than anyone's route.
    let signer = ctx.accounts.vault.signer();
    let seeds = signer.seeds();
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.source_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.source_token_account.to_account_info(),
                mint: ctx.accounts.source_mint.to_account_info(),
                to: ctx.accounts.caller_source_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
        ctx.accounts.source_mint.decimals,
    )?;

    // Invariant 2: price what actually left, not what was asked for. A
    // transfer fee on the wrapper makes those different numbers.
    ctx.accounts.source_token_account.reload()?;
    let balance_after = ctx.accounts.source_token_account.amount;
    let lent = balance_before
        .checked_sub(balance_after)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    require!(lent > 0, QuorumError::ZeroMintAmount);

    let source_gross_sold = {
        let mint_ai = ctx.accounts.source_mint.to_account_info();
        let data = mint_ai.try_borrow_data()?;
        wrapper_units(
            &ctx.accounts.source_wrapper,
            lent,
            &data,
            clock.unix_timestamp,
        )?
    };
    require!(source_gross_sold > 0, QuorumError::ZeroMintAmount);

    // Prove the settle exists before committing to the loan.
    let here = current_top_level_index(&ctx.accounts.instructions_sysvar)?;
    let settle_index = find_settle(&ctx.accounts.instructions_sysvar, here, &vault_key)?;

    let dest_balance_before = nav_before
        .contributions
        .iter()
        .find(|c| c.wrapper_mint == ctx.accounts.dest_wrapper.wrapper_mint)
        .map(|c| c.raw_balance)
        .ok_or_else(|| error!(QuorumError::NotARegisteredWrapper))?;

    let ticket = &mut ctx.accounts.ticket;
    ticket.bump = ctx.bumps.ticket;
    ticket.vault = vault_key;
    ticket.caller = ctx.accounts.caller.key();
    ticket.kind = kind;
    ticket.source_mint = ctx.accounts.source_wrapper.wrapper_mint;
    ticket.dest_mint = ctx.accounts.dest_wrapper.wrapper_mint;
    ticket.source_lent_raw = lent;
    ticket.source_gross_sold = source_gross_sold;
    ticket.min_dest_gross = floor_for(source_gross_sold, adjust_bps)?;
    ticket.total_gross_before = nav_before.total_gross_units;
    ticket.source_balance_after = balance_after;
    ticket.dest_balance_before = dest_balance_before;
    ticket.nav_per_token_before = nav_before.nav_per_token;
    ticket.unit_price_fp = price.price_fp;
    ticket.expected_end_index = settle_index;

    emit!(SwapLoanOpened {
        vault: vault_key,
        caller: ctx.accounts.caller.key(),
        kind,
        source_wrapper: ticket.source_mint,
        dest_wrapper: ticket.dest_mint,
        source_lent_raw: lent,
        source_gross_sold,
        min_dest_gross: ticket.min_dest_gross,
        settle_index,
    });
    Ok(())
}

/// Borrow a proven-depegged wrapper to sell. The settle requires the basket
/// to end with more underlying units than it started with.
pub fn begin_swap_depegged<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, BeginSwap<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(ctx.accounts.vault.swaps_allowed(), QuorumError::VaultPaused);

    let n = ctx.accounts.vault.wrapper_count as usize;
    let nav_len = n * 3;
    require!(
        ctx.remaining_accounts.len() == nav_len + 2,
        QuorumError::IncompleteWrapperAccounts
    );
    let (nav_accounts, prices) = ctx.remaining_accounts.split_at(nav_len);

    // Spec §9.1: an averaged price on both sides of the comparison, with the
    // live multiplier in fair value. The source mint is the third account of
    // its NAV triple.
    let underlying_ema: Account<'info, PriceUpdateV2> = Account::try_from(&prices[0])?;
    let underlying_fp = read_underlying_ema(&underlying_ema, &ctx.accounts.vault, &clock)?;
    let src_idx = ctx
        .accounts
        .vault
        .wrappers
        .iter()
        .position(|m| *m == ctx.accounts.source_wrapper.wrapper_mint)
        .ok_or_else(|| error!(QuorumError::NotARegisteredWrapper))?;
    let implied_fp = {
        let data = nav_accounts[src_idx * 3 + 2].try_borrow_data()?;
        implied_price_live(
            &ctx.accounts.source_wrapper,
            &data,
            clock.unix_timestamp,
            underlying_fp,
        )?
    };
    let wrapper_ema: Account<'info, PriceUpdateV2> = Account::try_from(&prices[1])?;
    let dev = read_deviation_ema(
        &ctx.accounts.source_wrapper,
        &ctx.accounts.vault,
        &wrapper_ema,
        implied_fp,
        &clock,
    )?;

    let v = &ctx.accounts.vault;
    let verdict = classify(
        dev.dev_bps,
        ctx.accounts.source_wrapper.depeg_since_ts,
        ctx.accounts.source_wrapper.depeg_direction,
        clock.unix_timestamp,
        v.soft_depeg_bps,
        v.hard_depeg_bps,
        v.min_depeg_duration_seconds,
    );
    require!(
        matches!(verdict, DepegVerdict::SoftDepeg | DepegVerdict::HardDepeg),
        QuorumError::DepegBelowThreshold
    );
    // Only ever sell the rich wrapper. Selling one already trading cheap
    // realises the loss and hands the spread to the other side.
    require!(dev.dev_bps > 0, QuorumError::DepegWrongDirection);

    preflight(
        &ctx.accounts.vault,
        &ctx.accounts.source_wrapper,
        &ctx.accounts.dest_wrapper,
        clock.unix_timestamp,
    )?;

    let min_gain = ctx.accounts.vault.min_gain_bps as i64;
    open_loan(
        &mut ctx,
        nav_accounts,
        amount,
        KIND_DEPEGGED,
        min_gain,
        &clock,
    )
}

/// Borrow from a leg that is over its target weight. The settle allows a
/// bounded loss, because crossing a spread to fix real drift is worth paying
/// for.
pub fn begin_rebalance<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, BeginSwap<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    // Spec §7: disabled while the market is closed, because the oracle is
    // flat and premiums are not meaningful.
    require!(
        ctx.accounts.vault.swaps_allowed(),
        QuorumError::MarketClosed
    );

    let n = ctx.accounts.vault.wrapper_count as usize;
    require!(
        ctx.remaining_accounts.len() == n * 3,
        QuorumError::IncompleteWrapperAccounts
    );
    let nav_accounts = ctx.remaining_accounts;

    preflight(
        &ctx.accounts.vault,
        &ctx.accounts.source_wrapper,
        &ctx.accounts.dest_wrapper,
        clock.unix_timestamp,
    )?;

    // The source really has to be over target by more than the trigger.
    let vault_key = ctx.accounts.vault.key();
    let price = read_underlying_price(&ctx.accounts.price_update, &ctx.accounts.vault, &clock)?;
    let nav = compute_nav(
        &ctx.accounts.vault,
        &vault_key,
        &price,
        ctx.accounts.index_mint.supply,
        nav_accounts,
        ctx.program_id,
        clock.unix_timestamp,
    )?;
    let source_units = nav
        .contributions
        .iter()
        .find(|c| c.wrapper_mint == ctx.accounts.source_wrapper.wrapper_mint)
        .map(|c| c.units)
        .unwrap_or(0);
    let w = weight_bps(source_units, nav.total_units)?;
    let target = ctx.accounts.source_wrapper.target_weight_bps as u128;
    require!(
        w > target && w - target >= ctx.accounts.vault.rebalance_drift_bps as u128,
        QuorumError::RebalanceNotNeeded
    );

    let max_loss = -(ctx.accounts.vault.max_loss_bps as i64);
    open_loan(
        &mut ctx,
        nav_accounts,
        amount,
        KIND_REBALANCE,
        max_loss,
        &clock,
    )
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

/// `remaining_accounts`: `3 * wrapper_count` NAV triples in registry order.
#[derive(Accounts)]
pub struct SettleSwap<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        close = caller,
        seeds = [SWAP_TICKET_SEED, vault.key().as_ref()],
        bump = ticket.bump,
        constraint = ticket.vault == vault.key() @ QuorumError::TicketMismatch,
        constraint = ticket.caller == caller.key() @ QuorumError::TicketMismatch,
    )]
    pub ticket: Box<Account<'info, SwapTicket>>,

    #[account(
        mut,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), source_wrapper.wrapper_mint.as_ref()],
        bump = source_wrapper.bump,
        constraint = source_wrapper.wrapper_mint == ticket.source_mint @ QuorumError::TicketMismatch,
    )]
    pub source_wrapper: Box<Account<'info, WrapperConfig>>,

    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), dest_wrapper.wrapper_mint.as_ref()],
        bump = dest_wrapper.bump,
        constraint = dest_wrapper.wrapper_mint == ticket.dest_mint @ QuorumError::TicketMismatch,
    )]
    pub dest_wrapper: Box<Account<'info, WrapperConfig>>,

    #[account(address = source_wrapper.vault_token_account @ QuorumError::WrapperAccountMismatch)]
    pub source_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        address = dest_wrapper.vault_token_account @ QuorumError::WrapperAccountMismatch,
    )]
    pub dest_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Where the caller pays the proceeds from.
    #[account(
        mut,
        constraint = caller_dest_account.mint == dest_wrapper.wrapper_mint
            @ QuorumError::OutputMintNotAllowed,
    )]
    pub caller_dest_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = dest_wrapper.wrapper_mint @ QuorumError::WrapperAccountMismatch)]
    pub dest_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = vault.index_mint @ QuorumError::WrapperAccountMismatch)]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Where the caller's reward is minted. Only used by the depeg path.
    #[account(
        mut,
        constraint = caller_index_account.mint == vault.index_mint
            @ QuorumError::WrapperAccountMismatch,
    )]
    pub caller_index_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    pub dest_token_program: Interface<'info, TokenInterface>,
    pub index_token_program: Interface<'info, TokenInterface>,

    /// CHECK: pinned to the instructions sysvar by address.
    #[account(address = INSTRUCTIONS_ID @ QuorumError::MustBeTopLevel)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct PermissionlessSwapDone {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub kind: u8,
    pub source_wrapper: Pubkey,
    pub dest_wrapper: Pubkey,
    pub source_units_sold: u128,
    pub dest_units_gained: u128,
    pub gross_units_before: u128,
    pub gross_units_after: u128,
    pub caller_reward: u64,
}

/// Repay the loan and check the result. `amount` is what the caller pays in;
/// what counts is the measured arrival.
pub fn end_swap<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleSwap<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();

    // The ticket named the index this must run at, so the settle the loan was
    // approved against is the settle that executes.
    let here = current_top_level_index(&ctx.accounts.instructions_sysvar)?;
    require!(
        here == ctx.accounts.ticket.expected_end_index,
        QuorumError::SettleIndexMismatch
    );

    // Nothing may have taken from the source leg while the loan was out.
    require!(
        ctx.accounts.source_token_account.amount >= ctx.accounts.ticket.source_balance_after,
        QuorumError::SourceLegTampered
    );

    let n = ctx.accounts.vault.wrapper_count as usize;
    require!(
        ctx.remaining_accounts.len() == n * 3,
        QuorumError::IncompleteWrapperAccounts
    );
    let nav_accounts = ctx.remaining_accounts;

    // Take the proceeds. The caller is the authority, so this moves the
    // caller's own tokens and needs no vault signature.
    let dest_before = ctx.accounts.dest_token_account.amount;
    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.dest_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.caller_dest_account.to_account_info(),
                    mint: ctx.accounts.dest_mint.to_account_info(),
                    to: ctx.accounts.dest_token_account.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.dest_mint.decimals,
        )?;
    }
    ctx.accounts.dest_token_account.reload()?;
    let dest_received = ctx
        .accounts
        .dest_token_account
        .amount
        .checked_sub(dest_before)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;

    let dest_units_gained = {
        let mint_ai = ctx.accounts.dest_mint.to_account_info();
        let data = mint_ai.try_borrow_data()?;
        wrapper_units(
            &ctx.accounts.dest_wrapper,
            dest_received,
            &data,
            clock.unix_timestamp,
        )?
    };

    // 1. The declared leg cleared its floor, on gross units.
    require!(
        dest_units_gained >= ctx.accounts.ticket.min_dest_gross,
        QuorumError::UnitsBoundViolated
    );

    let price = read_underlying_price(&ctx.accounts.price_update, &ctx.accounts.vault, &clock)?;
    let nav_after = compute_nav(
        &ctx.accounts.vault,
        &vault_key,
        &price,
        ctx.accounts.index_mint.supply,
        nav_accounts,
        ctx.program_id,
        clock.unix_timestamp,
    )?;

    // 2. The basket as a whole is where it should be. The loan left one leg
    //    and the floor came back into another, so units missing anywhere else
    //    show up here as a shortfall.
    let expected_min_total = ctx
        .accounts
        .ticket
        .total_gross_before
        .checked_sub(ctx.accounts.ticket.source_gross_sold)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?
        .checked_add(ctx.accounts.ticket.min_dest_gross)
        .ok_or_else(|| error!(QuorumError::MathOverflow))?;
    require!(
        nav_after.total_gross_units >= expected_min_total,
        QuorumError::UnitsBoundViolated
    );

    // 3. The issuer cap binds here too, or a caller could be paid to
    //    concentrate the basket into one issuer.
    let dest_units_after = nav_after
        .contributions
        .iter()
        .find(|c| c.wrapper_mint == ctx.accounts.dest_wrapper.wrapper_mint)
        .map(|c| c.units)
        .unwrap_or(0);
    require!(
        weight_bps(dest_units_after, nav_after.total_units)?
            <= ctx.accounts.dest_wrapper.max_weight_bps as u128,
        QuorumError::DestinationOverCap
    );

    // Reward, on the depeg path only: a share of the realised gain, priced at
    // the open so the caller cannot improve it by choosing when to settle.
    let kind = ctx.accounts.ticket.kind;
    let source_gross_sold = ctx.accounts.ticket.source_gross_sold;
    let total_gross_before = ctx.accounts.ticket.total_gross_before;
    let nav_per_token_before = ctx.accounts.ticket.nav_per_token_before;
    let unit_price_fp = ctx.accounts.ticket.unit_price_fp;

    let mut reward: u64 = 0;
    if kind == KIND_DEPEGGED {
        let gain = dest_units_gained.saturating_sub(source_gross_sold);
        let reward_bps = ctx.accounts.vault.caller_reward_bps as u128;
        if gain > 0 && reward_bps > 0 && nav_per_token_before > 0 {
            let usd = gain
                .checked_mul(unit_price_fp)
                .ok_or_else(|| error!(QuorumError::MathOverflow))?
                / UNITS_SCALE;
            let idx = usd
                .checked_mul(10u128.pow(INDEX_DECIMALS as u32))
                .ok_or_else(|| error!(QuorumError::MathOverflow))?
                / nav_per_token_before;
            reward = u64::try_from(idx * reward_bps / BPS_DENOM as u128)
                .map_err(|_| error!(QuorumError::MathOverflow))?;
        }
    }
    if reward > 0 {
        let signer = ctx.accounts.vault.signer();
        let seeds = signer.seeds();
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.index_token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.index_mint.to_account_info(),
                    to: ctx.accounts.caller_index_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            reward,
        )?;
    }

    ctx.accounts.vault.last_permissionless_swap_ts = clock.unix_timestamp;
    ctx.accounts.source_wrapper.last_permissionless_swap_ts = clock.unix_timestamp;

    emit!(PermissionlessSwapDone {
        vault: vault_key,
        caller: ctx.accounts.caller.key(),
        kind,
        source_wrapper: ctx.accounts.source_wrapper.wrapper_mint,
        dest_wrapper: ctx.accounts.dest_wrapper.wrapper_mint,
        source_units_sold: source_gross_sold,
        dest_units_gained,
        gross_units_before: total_gross_before,
        gross_units_after: nav_after.total_gross_units,
        caller_reward: reward,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gain_floor_requires_more_than_sold() {
        // min_gain 1bp on 1e9 units sold -> need 1_000_100_000
        assert_eq!(floor_for(1_000_000_000, 1).unwrap(), 1_000_100_000);
    }

    #[test]
    fn loss_floor_is_relative_to_the_trade_not_the_basket() {
        // 25bp loss on 1e9 units sold -> may receive as little as 997.5M,
        // regardless of how big the rest of the basket is.
        assert_eq!(floor_for(1_000_000_000, -25).unwrap(), 997_500_000);
    }
}
