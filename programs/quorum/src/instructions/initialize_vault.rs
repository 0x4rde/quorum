use anchor_lang::prelude::*;
use anchor_spl::{token_2022::Token2022, token_interface::Mint};

use crate::constants::*;
use crate::errors::QuorumError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeVaultArgs {
    /// Ticker, e.g. "qNVDA". Longer than 12 bytes is truncated by the caller.
    pub symbol: String,
    pub unit: Unit,
    /// Pyth feed id of the REAL asset. Never a wrapper's feed.
    pub underlying_feed_id: [u8; 32],
    pub guardian: Pubkey,
    pub max_age_seconds: u64,
    pub max_conf_bps: u16,
    pub fee_mint_bps: u16,
    pub fee_redeem_bps: u16,
    pub market_closed_surcharge_bps: u16,
    /// Zero means use the `Quorum_Spec_v5.pdf` §9.2 defaults.
    pub nav_breaker_bps: u16,
    pub nav_breaker_window_seconds: i64,
}

/// Fill any zero field with its spec default, so a caller can pass
/// `Default::default()` and get the documented behaviour rather than a vault
/// with every guard disabled.
macro_rules! or_default {
    ($v:expr, $d:expr) => {
        if $v == 0 {
            $d
        } else {
            $v
        }
    };
}

#[derive(Accounts)]
#[instruction(args: InitializeVaultArgs)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [VAULT_SEED, args.symbol.as_bytes()],
        bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// The index token (qNVDA / qSPY / qGOLD). Mint authority is the vault PDA,
    /// so only the program can ever mint or burn it.
    #[account(
        init,
        payer = authority,
        seeds = [INDEX_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = INDEX_DECIMALS,
        mint::authority = vault,
        mint::freeze_authority = vault,
        mint::token_program = index_token_program,
    )]
    pub index_mint: Box<InterfaceAccount<'info, Mint>>,

    pub index_token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_vault(ctx: Context<InitializeVault>, args: InitializeVaultArgs) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // This PDA is derived from the full symbol, but every later instruction
    // derives from `symbol_seed()`, which stops at 12 bytes or the first NUL. A
    // symbol that does not survive that round trip creates a vault no
    // instruction can address again, with the rent locked inside it.
    let bytes = args.symbol.as_bytes();
    require!(
        !bytes.is_empty() && bytes.len() <= 12 && !bytes.contains(&0),
        QuorumError::InvalidSymbol
    );
    let mut symbol = [0u8; 12];
    symbol[..bytes.len()].copy_from_slice(bytes);

    // A fee at or above 100% would be accepted here and then rejected by
    // apply_fee on every mint: a vault that can never be used.
    require!(
        args.fee_mint_bps < BPS_DENOM as u16
            && args.fee_redeem_bps < BPS_DENOM as u16
            && (args.fee_mint_bps as u64 + args.market_closed_surcharge_bps as u64) < BPS_DENOM
            && args.max_conf_bps <= BPS_DENOM as u16,
        QuorumError::InvalidParameter
    );

    vault.bump = ctx.bumps.vault;
    vault.symbol = symbol;
    vault.unit = args.unit;
    // A vault opens PAUSED. Registering wrappers and seeding come first; the
    // authority flips it live once the registry is actually populated.
    vault.status = VaultStatus::Paused;

    vault.authority = ctx.accounts.authority.key();
    vault.guardian = args.guardian;

    vault.index_mint = ctx.accounts.index_mint.key();
    vault.index_mint_bump = ctx.bumps.index_mint;

    vault.underlying_feed_id = args.underlying_feed_id;
    vault.max_age_seconds = or_default!(args.max_age_seconds, DEFAULT_MAX_AGE_SECONDS);
    vault.max_conf_bps = or_default!(args.max_conf_bps, DEFAULT_MAX_CONF_BPS);

    vault.fee_mint_bps = args.fee_mint_bps;
    vault.fee_redeem_bps = args.fee_redeem_bps;
    vault.market_closed_surcharge_bps = args.market_closed_surcharge_bps;
    vault.nav_breaker_bps = or_default!(args.nav_breaker_bps, DEFAULT_NAV_BREAKER_BPS);
    vault.nav_breaker_window_seconds = or_default!(
        args.nav_breaker_window_seconds,
        DEFAULT_NAV_BREAKER_WINDOW_SECONDS
    );

    vault.soft_depeg_bps = DEFAULT_SOFT_DEPEG_BPS;
    vault.hard_depeg_bps = DEFAULT_HARD_DEPEG_BPS;
    vault.min_depeg_duration_seconds = DEFAULT_MIN_DEPEG_DURATION_SECONDS;
    vault.twap_window_seconds = DEFAULT_TWAP_WINDOW_SECONDS;
    vault.max_swap_bps = DEFAULT_MAX_SWAP_BPS;
    vault.swap_cooldown_seconds = DEFAULT_SWAP_COOLDOWN_SECONDS;
    vault.caller_reward_bps = DEFAULT_CALLER_REWARD_BPS;
    vault.rebalance_drift_bps = DEFAULT_REBALANCE_DRIFT_BPS;
    vault.max_loss_bps = DEFAULT_MAX_LOSS_BPS;
    vault.min_gain_bps = DEFAULT_MIN_GAIN_BPS;

    vault.wrapper_count = 0;
    vault.wrappers = [Pubkey::default(); Vault::MAX_WRAPPERS];

    vault.nav_anchor_per_token = 0;
    vault.nav_anchor_ts = 0;
    vault.last_permissionless_swap_ts = 0;
    vault.nav_per_token = 0;
    vault.nav_total = 0;
    vault.nav_updated_slot = 0;
    vault.nav_updated_ts = 0;
    vault.reserved = [0u8; 64];

    msg!(
        "vault {} initialized (PAUSED until wrappers are registered)",
        args.symbol
    );
    Ok(())
}
