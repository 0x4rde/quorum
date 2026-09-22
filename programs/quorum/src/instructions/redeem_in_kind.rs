use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::*;
use crate::economics::{apply_fee, prorata_out};
use crate::errors::QuorumError;
use crate::nav::walk_registry;
use crate::state::*;
use crate::units::apply_haircut;

/// In-kind redeem (`Quorum_Spec_v5.pdf` §6.3). Burn index tokens, receive a
/// pro-rata slice of every wrapper the vault holds.
///
/// This instruction reads no oracle, by design: `your_share = burn / supply`
/// does not need to know what anything is worth, so the path stays open when
/// everything else is shut. It is the "exit is always open" guarantee of spec
/// §1 and §6.3.
///
/// Quarantined wrappers are paid out, against a literal reading of spec §9.2,
/// which would forfeit a holder's claim on an asset the vault still holds.
///
/// `remaining_accounts`: one quad per registered wrapper, in registry order,
/// as `(wrapper_config, vault_token_account, wrapper_mint, user_token_account)`.
#[derive(Accounts)]
pub struct RedeemInKind<'info> {
    pub user: Signer<'info>,

    #[account(seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut, address = vault.index_mint @ QuorumError::WrapperAccountMismatch)]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = user_index_account.mint == vault.index_mint @ QuorumError::WrapperAccountMismatch,
    )]
    pub user_index_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// SPL Token program, for wrappers owned by it.
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 program, for wrappers owned by it and for the index mint.
    pub token_program_2022: Interface<'info, TokenInterface>,
}

#[event]
pub struct RedeemedInKind {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub index_burned: u64,
    pub supply_before: u64,
    pub fee_bps: u16,
}

#[event]
pub struct RedeemLeg {
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    pub amount_out: u64,
}

pub fn redeem_in_kind<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemInKind<'info>>,
    index_amount: u64,
) -> Result<()> {
    require!(index_amount > 0, QuorumError::ZeroMintAmount);

    let vault_key = ctx.accounts.vault.key();
    let supply_before = ctx.accounts.index_mint.supply;
    require!(supply_before > 0, QuorumError::ZeroSupply);
    require!(index_amount <= supply_before, QuorumError::MathOverflow);

    // The fee reduces the payout rather than being collected: what the redeemer
    // does not take stays in the basket and lifts NAV for everyone else.
    let fee_bps = ctx.accounts.vault.fee_redeem_bps;
    let effective = apply_fee(index_amount as u128, fee_bps)?;

    let signer = ctx.accounts.vault.signer();
    let seeds = signer.seeds();

    // --- Burn first ---
    //
    // Burning before paying out means a failure anywhere in the payout loop
    // reverts the whole transaction with the tokens still in the user's hands.
    // The reverse order would leave a window where the vault has paid out
    // against tokens that still exist.
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_program_2022.to_account_info(),
            Burn {
                mint: ctx.accounts.index_mint.to_account_info(),
                from: ctx.accounts.user_index_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        index_amount,
    )?;

    // --- Pay out each leg pro-rata ---
    //
    // Quad per wrapper: the registry triple plus the user's receiving account.
    // Validation is walk_registry's, the same path NAV trusts.
    let legs = walk_registry(
        &ctx.accounts.vault,
        &vault_key,
        ctx.program_id,
        ctx.remaining_accounts,
        4,
    )?;

    for leg in &legs {
        let registered_mint = leg.wrapper.wrapper_mint;
        let user_token_ai = &leg.extra[0];
        let user_token: InterfaceAccount<'info, TokenAccount> =
            InterfaceAccount::try_from(user_token_ai)?;
        require_keys_eq!(
            user_token.mint,
            registered_mint,
            QuorumError::WrapperAccountMismatch
        );

        // The exit must not have a single point of failure. A leg whose token
        // account the issuer has frozen would fail transfer_checked and take
        // every holder's redeem down with it, so frozen legs are skipped here
        // and valued at zero in NAV, so nobody pays for a share they cannot
        // receive; it stays for whoever holds when it thaws.
        if matches!(leg.wrapper.status, WrapperStatus::Frozen) {
            continue;
        }

        // Pro-rata on the RAW balance, deliberately. The Scaled UI multiplier
        // applies equally to the vault's balance and to what the user receives,
        // so it cancels: a raw ratio already delivers the correct share of the
        // scaled amount. Applying the multiplier here would double-count it.
        let full_share = prorata_out(leg.token_account.amount, effective, supply_before)?;

        // NAV haircuts a quarantined leg, so a mint is priced against the
        // discounted basket. Paying that leg out at full weight would let
        // anyone mint against the haircut and redeem without it, pocketing the
        // gap. The withheld part stays in the vault.
        let amount_out = u64::try_from(apply_haircut(
            full_share as u128,
            leg.wrapper.nav_haircut_bps(),
        )?)
        .map_err(|_| error!(QuorumError::MathOverflow))?;

        if amount_out == 0 {
            // A dust redeem against a thin leg can round to nothing. Skip it
            // rather than failing the whole exit.
            continue;
        }

        let mint_acc: InterfaceAccount<'info, Mint> = InterfaceAccount::try_from(leg.mint_ai)?;
        let token_program = if leg.wrapper.is_token_2022 {
            ctx.accounts.token_program_2022.to_account_info()
        } else {
            ctx.accounts.token_program.to_account_info()
        };

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: leg.token_ai.clone(),
                    mint: leg.mint_ai.clone(),
                    to: user_token_ai.clone(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[&seeds],
            ),
            amount_out,
            mint_acc.decimals,
        )?;

        emit!(RedeemLeg {
            vault: vault_key,
            wrapper_mint: registered_mint,
            amount_out
        });
    }

    emit!(RedeemedInKind {
        vault: vault_key,
        user: ctx.accounts.user.key(),
        index_burned: index_amount,
        supply_before,
        fee_bps,
    });

    Ok(())
}
