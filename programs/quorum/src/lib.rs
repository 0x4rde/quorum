//! Quorum: issuer-diversified RWA vaults on Solana.
//!
//! Each vault holds every major tokenized wrapper of one real-world asset and
//! issues a single index token against the basket. CLAUDE.md lists the seven
//! invariants this program exists to enforce; the load-bearing ones here:
//!
//! - The program contains no CPI into a DEX or aggregator at all. Users and
//!   arbitrageurs compose their own swaps around its instructions.
//! - NAV never reads a DEX price (`nav`); DEX prices only detect depegs.
//! - Swap legs are checked against the registry, never against caller input.
//! - Wrapper balances are read as Scaled UI amounts where the mint has one
//! (`units`).
//!
//! # References in these comments
//!
//! Each is named in full on its first use in a file, and in short form after
//! that:
//!
//! - `spec §N`: section N of `Quorum_Spec_v5.pdf` in the repo root. Read it
//!   with `pdftotext -layout Quorum_Spec_v5.pdf -`.
//! - `invariant N`: the numbered list under "The seven invariants" in
//!   `README.md`.
//! - `invariant N` is the numbered list under "The seven invariants".

use anchor_lang::prelude::*;

pub mod constants;
pub mod depeg;
pub mod economics;
pub mod errors;
pub mod instructions;
pub mod nav;
pub mod oracle;
pub mod state;
pub mod units;

#[cfg(test)]
mod tests_scaled_ui;

use instructions::*;
use state::WrapperStatus;

declare_id!("3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi");

#[program]
pub mod quorum {
    use super::*;

    /// Create a vault and its index mint. Opens PAUSED.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        args: InitializeVaultArgs,
    ) -> Result<()> {
        instructions::initialize_vault::initialize_vault(ctx, args)
    }

    /// Admit a wrapper to a vault's registry and open its PDA-owned holding
    /// account.
    pub fn register_wrapper(
        ctx: Context<RegisterWrapper>,
        args: RegisterWrapperArgs,
    ) -> Result<()> {
        instructions::register_wrapper::register_wrapper(ctx, args)
    }

    // --- Configuration (authority only) ---

    /// Hand the vault to a new authority.
    pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::set_authority(ctx, new_authority)
    }

    /// Rotate the guardian key.
    pub fn set_guardian(ctx: Context<AuthorityOnly>, new_guardian: Pubkey) -> Result<()> {
        instructions::admin::set_guardian(ctx, new_guardian)
    }

    /// Update vault parameters. Every field is optional; ranges are checked.
    pub fn update_vault_config(
        ctx: Context<AuthorityOnly>,
        update: VaultConfigUpdate,
    ) -> Result<()> {
        instructions::admin::update_vault_config(ctx, update)
    }

    /// Update one wrapper's parameters. A `units_per_token` move over 1% needs
    /// the guardian to co-sign (`Quorum_Spec_v5.pdf` §8).
    pub fn update_wrapper_config(
        ctx: Context<UpdateWrapperConfig>,
        update: WrapperConfigUpdate,
    ) -> Result<()> {
        instructions::admin::update_wrapper_config(ctx, update)
    }

    // --- User paths ---

    /// Deposit a whitelisted wrapper, receive index tokens. No swap, no
    /// slippage.
    pub fn mint_in_kind<'info>(
        ctx: Context<'_, '_, 'info, 'info, MintInKind<'info>>,
        amount: u64,
        min_index_out: u64,
    ) -> Result<()> {
        instructions::mint_in_kind::mint_in_kind(ctx, amount, min_index_out)
    }

    /// Burn index tokens for a pro-rata slice of every wrapper. Reads no
    /// oracle, so it stays open when everything else is shut.
    pub fn redeem_in_kind<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemInKind<'info>>,
        index_amount: u64,
    ) -> Result<()> {
        instructions::redeem_in_kind::redeem_in_kind(ctx, index_amount)
    }

    // --- Guards (spec §9) ---

    /// Guardian or authority. Restricts only; in-kind redeem stays open.
    pub fn pause(ctx: Context<GuardianAction>) -> Result<()> {
        instructions::guards::pause(ctx)
    }

    /// Authority only. Spec §9.2: unpausing needs the full multisig.
    pub fn unpause(ctx: Context<AuthorityAction>) -> Result<()> {
        instructions::guards::unpause(ctx)
    }

    /// Guardian may close the market; only the authority may re-open it.
    pub fn set_market_closed(ctx: Context<GuardianAction>, closed: bool) -> Result<()> {
        instructions::guards::set_market_closed(ctx, closed)
    }

    /// Tightening is available to the guardian; loosening needs the authority.
    pub fn set_wrapper_status(ctx: Context<SetWrapperStatus>, status: WrapperStatus) -> Result<()> {
        instructions::guards::set_wrapper_status(ctx, status)
    }

    /// Permissionless: cross-check the mint's Scaled UI multiplier against
    /// Pyth's redemption-rate feed. Invariant 5 (`README.md`), observable at
    /// runtime.
    pub fn verify_redemption_rate(ctx: Context<VerifyRedemptionRate>) -> Result<()> {
        instructions::guards::verify_redemption_rate(ctx)
    }

    /// Permissionless: evaluate a wrapper's depeg and apply the guard table.
    pub fn check_depeg(ctx: Context<CheckDepeg>) -> Result<()> {
        instructions::guards::check_depeg(ctx)
    }

    // --- Permissionless, bounded (invariant 4) ---

    /// Borrow a proven-depegged wrapper to sell. Anyone may call. Must be
    /// paired with `end_swap` later in the same transaction, and the basket
    /// must end with more underlying units than it started with.
    pub fn begin_swap_depegged<'info>(
        ctx: Context<'_, '_, 'info, 'info, BeginSwap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::permissionless_swap::begin_swap_depegged(ctx, amount)
    }

    /// Borrow from a leg that is over target weight. Anyone may call. The
    /// basket may lose at most `max_loss_bps` of the amount traded.
    pub fn begin_rebalance<'info>(
        ctx: Context<'_, '_, 'info, 'info, BeginSwap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::permissionless_swap::begin_rebalance(ctx, amount)
    }

    /// Repay a loan opened by either `begin_` instruction and enforce the
    /// bounds. Whatever filled the trade in between is irrelevant here.
    pub fn end_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleSwap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::permissionless_swap::end_swap(ctx, amount)
    }

    /// Recompute NAV from Pyth plus the on-chain basket. Permissionless.
    pub fn update_nav<'info>(ctx: Context<'_, '_, 'info, 'info, UpdateNav<'info>>) -> Result<()> {
        instructions::update_nav::update_nav(ctx)
    }
}
