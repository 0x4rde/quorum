use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            permanent_delegate::PermanentDelegate, scaled_ui_amount::ScaledUiAmountConfig,
            transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
        },
        state::Mint as SplMint,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::*;
use crate::errors::QuorumError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterWrapperArgs {
    /// Fixed point at `UNIT_SCALE`. For a Scaled-UI wrapper this is the base,
    /// and the live mint multiplier is applied on top at read time.
    pub units_per_token: u128,
    pub multiplier_source: MultiplierSource,
    pub target_weight_bps: u16,
    pub max_weight_bps: u16,
    pub haircut_bps: u16,
    /// Pool account for the depeg TWAP. `Pubkey::default()` means unset.
    pub dex_price_source: Pubkey,
    pub wrapper_feed_id: [u8; 32],
    pub has_wrapper_feed: bool,
    /// Pyth `Crypto.<WRAPPER>/<UNDERLYING>.RR` feed, where one exists.
    pub rr_feed_id: [u8; 32],
    pub has_rr_feed: bool,
}

#[derive(Accounts)]
pub struct RegisterWrapper<'info> {
    #[account(mut, constraint = authority.key() == vault.authority @ QuorumError::NotAuthority)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, vault.symbol_seed()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = WrapperConfig::LEN,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// The vault's holding account for this wrapper, PDA-owned.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump,
        token::mint = wrapper_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn register_wrapper(ctx: Context<RegisterWrapper>, args: RegisterWrapperArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let mint_key = ctx.accounts.wrapper_mint.key();

    require!(
        (vault.wrapper_count as usize) < Vault::MAX_WRAPPERS,
        QuorumError::RegistryFull
    );
    require!(
        !vault.is_registered(&mint_key),
        QuorumError::WrapperAlreadyRegistered
    );

    let mint_ai = ctx.accounts.wrapper_mint.to_account_info();
    let is_token_2022 = mint_ai.owner == &anchor_spl::token_2022::ID;

    // Record the restriction surface at registration time (`Quorum_Spec_v5.pdf`
    // §9.2). None of these reject on their own, since the issuer caps are what
    // bound a permanent delegate, but the monitor bot watches anything flagged
    // here. The Scaled UI cross-check below is a hard stop.
    let mut has_permanent_delegate = false;
    let mut has_transfer_hook = false;
    let mut mint_has_scaled_ui = false;

    if is_token_2022 {
        let data = mint_ai.try_borrow_data()?;
        let state = StateWithExtensions::<SplMint>::unpack(&data)
            .map_err(|_| error!(QuorumError::MathOverflow))?;

        if let Ok(pd) = state.get_extension::<PermanentDelegate>() {
            let delegate: Option<Pubkey> = pd.delegate.into();
            has_permanent_delegate = delegate.is_some();
        }
        if let Ok(hook) = state.get_extension::<TransferHook>() {
            let program_id: Option<Pubkey> = hook.program_id.into();
            has_transfer_hook = program_id.is_some();
        }
        mint_has_scaled_ui = state.get_extension::<ScaledUiAmountConfig>().is_ok();
    }

    // Invariant 5 (`README.md`), enforced at the only moment where it is cheap
    // to catch: registration. Getting this pair wrong is the silent NAV bug, so
    // the two descriptions of reality have to agree before the wrapper is
    // admitted.
    match args.multiplier_source {
        MultiplierSource::Token2022ScaledUi => {
            require!(mint_has_scaled_ui, QuorumError::ScaledUiExtensionMissing);
        }
        MultiplierSource::Fixed | MultiplierSource::KeeperPushed => {
            require!(!mint_has_scaled_ui, QuorumError::ScaledUiConfigMismatch);
        }
    }

    // A haircut above 100% makes apply_haircut fail once the wrapper is
    // quarantined, and redeem_in_kind calls it, so every holder's exit would
    // revert. A units_per_token of zero makes every deposit worthless.
    require!(
        args.haircut_bps <= BPS_DENOM as u16
            && args.target_weight_bps <= BPS_DENOM as u16
            && args.max_weight_bps <= BPS_DENOM as u16
            && args.units_per_token > 0,
        QuorumError::InvalidParameter
    );

    let wrapper = &mut ctx.accounts.wrapper_config;
    wrapper.bump = ctx.bumps.wrapper_config;
    wrapper.vault = vault.key();
    wrapper.wrapper_mint = mint_key;
    wrapper.vault_token_account = ctx.accounts.vault_token_account.key();
    wrapper.decimals = ctx.accounts.wrapper_mint.decimals;
    wrapper.is_token_2022 = is_token_2022;

    wrapper.units_per_token = args.units_per_token;
    wrapper.multiplier_source = args.multiplier_source;
    wrapper.target_weight_bps = args.target_weight_bps;
    wrapper.max_weight_bps = if args.max_weight_bps == 0 {
        DEFAULT_MAX_WEIGHT_BPS
    } else {
        args.max_weight_bps
    };
    wrapper.haircut_bps = args.haircut_bps;
    // A freshly registered wrapper is ACTIVE but the vault itself is still
    // PAUSED until the authority says otherwise, so nothing is live yet.
    wrapper.status = WrapperStatus::Active;

    wrapper.dex_price_source = args.dex_price_source;
    wrapper.wrapper_feed_id = args.wrapper_feed_id;
    wrapper.has_wrapper_feed = args.has_wrapper_feed;
    wrapper.rr_feed_id = args.rr_feed_id;
    wrapper.has_rr_feed = args.has_rr_feed;
    wrapper.last_rr = 0;
    wrapper.last_rr_ts = 0;

    wrapper.depeg_since_ts = 0;
    wrapper.depeg_direction = 0;
    wrapper.last_permissionless_swap_ts = 0;

    wrapper.has_freeze_authority = ctx.accounts.wrapper_mint.freeze_authority.is_some();
    wrapper.has_permanent_delegate = has_permanent_delegate;
    wrapper.has_transfer_hook = has_transfer_hook;
    wrapper.reserved = [0u8; 64];

    let slot = vault.wrapper_count as usize;
    vault.wrappers[slot] = mint_key;
    vault.wrapper_count += 1;

    msg!(
        "registered wrapper {} (token2022={}, scaled_ui={}, perm_delegate={}, hook={}, freeze={})",
        mint_key,
        is_token_2022,
        mint_has_scaled_ui,
        has_permanent_delegate,
        has_transfer_hook,
        wrapper.has_freeze_authority,
    );
    Ok(())
}
