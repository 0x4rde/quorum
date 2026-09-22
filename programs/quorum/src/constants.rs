/// Fixed-point scale for `units_per_token` and for multipliers: 1e9. One "unit"
/// is one underlying share or one troy ounce, depending on the vault.
pub const UNIT_SCALE: u128 = 1_000_000_000;

/// Fixed-point scale for internal unit accounting (nano-units).
pub const UNITS_SCALE: u128 = 1_000_000_000;

/// Fixed-point scale for the Token-2022 Scaled UI multiplier: 1e18.
///
/// Wider than `UNIT_SCALE` on purpose. The multiplier is an f64 of 15 to 16
/// significant digits, and at 1e9 the tail of a value like 1.0009180758 is
/// lost. That tail is a dividend.
pub const MULTIPLIER_SCALE: u128 = 1_000_000_000_000_000_000;

/// Fixed-point scale for oracle prices (USD per unit): 1e9.
pub const PRICE_SCALE: u128 = 1_000_000_000;

/// Fixed-point scale for NAV and nav_per_token (USD): 1e9.
pub const NAV_SCALE: u128 = 1_000_000_000;

/// Basis points denominator.
pub const BPS_DENOM: u64 = 10_000;

/// Decimals of the index token (qNVDA, qSPY, qGOLD).
pub const INDEX_DECIMALS: u8 = 9;

pub const VAULT_SEED: &[u8] = b"vault";
pub const WRAPPER_SEED: &[u8] = b"wrapper";
pub const INDEX_MINT_SEED: &[u8] = b"index_mint";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const SWAP_TICKET_SEED: &[u8] = b"swap_ticket";

/// Defaults from `Quorum_Spec_v5.pdf` §4.
pub const DEFAULT_MAX_WEIGHT_BPS: u16 = 4_000;
pub const DEFAULT_FEE_MINT_BPS: u16 = 10;
pub const DEFAULT_FEE_REDEEM_BPS: u16 = 10;

/// Spec §9: oracle health.
pub const DEFAULT_MAX_AGE_SECONDS: u64 = 60;
pub const DEFAULT_MAX_CONF_BPS: u16 = 100;

/// Spec §8: a `units_per_token` move larger than this needs guardian co-sign.
pub const UNITS_PER_TOKEN_GUARDED_MOVE_BPS: u64 = 100;

/// Spec §9.2: NAV moving more than this inside the window trips a global pause.
pub const DEFAULT_NAV_BREAKER_BPS: u16 = 800;
pub const DEFAULT_NAV_BREAKER_WINDOW_SECONDS: i64 = 600;

/// Spec §9.1 defaults.
pub const DEFAULT_SOFT_DEPEG_BPS: u16 = 200;
pub const DEFAULT_HARD_DEPEG_BPS: u16 = 500;
pub const DEFAULT_MIN_DEPEG_DURATION_SECONDS: i64 = 600;
pub const DEFAULT_MAX_SWAP_BPS: u16 = 1_000;
pub const DEFAULT_SWAP_COOLDOWN_SECONDS: i64 = 300;
pub const DEFAULT_CALLER_REWARD_BPS: u16 = 1_000;
pub const DEFAULT_REBALANCE_DRIFT_BPS: u16 = 500;
pub const DEFAULT_MAX_LOSS_BPS: u16 = 25;
pub const DEFAULT_MIN_GAIN_BPS: u16 = 1;
/// Spec §9.2: NAV haircut applied to a quarantined wrapper.
pub const DEFAULT_HAIRCUT_BPS: u16 = 1_000;

/// Window for the depeg TWAP. Spec §9.1 rules out the spot tick, so one
/// sandwiched block cannot fake a depeg.
pub const DEFAULT_TWAP_WINDOW_SECONDS: u64 = 300;

/// How far the mint's Scaled UI multiplier may drift from Pyth's redemption
/// rate before the wrapper is quarantined.
///
/// Sized against the bug it catches: a raw-balance read diverges by the
/// wrapper's cumulative drift, 94bps for SPYon today, so a 100bps tolerance
/// would miss it. See the calibration tests in `depeg.rs`.
pub const MAX_RR_DIVERGENCE_BPS: u64 = 50;
