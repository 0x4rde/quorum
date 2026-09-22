//! Error codes, grouped by the rule each one enforces.
//!
//! Section headers cite `Quorum_Spec_v5.pdf` as `spec §N` and the invariant
//! list in `README.md` as `invariant N`.

use anchor_lang::prelude::*;

#[error_code]
pub enum QuorumError {
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // --- registry / whitelist (invariant 3, spec §6.4) ---
    #[msg("Mint is not a registered wrapper of this vault")]
    NotARegisteredWrapper,
    #[msg("Output mint is not in this vault's allowed_out set")]
    OutputMintNotAllowed,
    #[msg("Input mint is not allowed on this path")]
    InputMintNotAllowed,
    #[msg("Wrapper is already registered")]
    WrapperAlreadyRegistered,
    #[msg("Vault symbol must be 1-12 bytes with no NUL")]
    InvalidSymbol,
    #[msg("Vault wrapper registry is full")]
    RegistryFull,

    // --- status ---
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Market is closed for this action")]
    MarketClosed,
    #[msg("Wrapper is not ACTIVE")]
    WrapperNotActive,
    #[msg("Wrapper is quarantined")]
    WrapperQuarantined,
    #[msg("Wrapper is frozen: its token account cannot move")]
    WrapperFrozen,
    #[msg("Minting is disabled for this wrapper")]
    WrapperMintDisabled,
    #[msg("A wrapper is quarantined or frozen; only the authority may mint until it is cleared")]
    VaultImpaired,

    // --- oracle (spec §5, §9) ---
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle confidence interval is too wide")]
    OracleConfidenceTooWide,
    #[msg("Oracle price is not positive")]
    OracleInvalidPrice,
    #[msg("Oracle feed id does not match the vault's configured feed")]
    OracleFeedMismatch,

    // --- weights and caps (spec §9.2) ---
    #[msg("Deposit would push the wrapper past max_weight_bps")]
    IssuerCapExceeded,
    #[msg("Trade would push the destination wrapper past max_weight_bps")]
    DestinationOverCap,

    // --- swaps (invariants 2 and 4) ---
    #[msg("Measured units received are below min_units_out")]
    SlippageExceeded,
    #[msg("Swap would leave the vault holding fewer units than the bound allows")]
    UnitsBoundViolated,
    #[msg("Swap size exceeds max_swap_bps for this call")]
    SwapSizeExceeded,
    #[msg("A vault-signed route moved a leg it did not declare")]
    RouteTouchedUndeclaredLeg,
    #[msg("Vault does not hold enough of that wrapper to cover the claim")]
    InsufficientWrapperBalance,
    #[msg("Cooldown has not elapsed since the last permissionless swap")]
    CooldownActive,
    #[msg("A vault-signed route left a delegate, close authority or owner change behind")]
    AccountStateTampered,
    #[msg("This instruction must be top level, not invoked by another program")]
    MustBeTopLevel,
    #[msg("No matching settle instruction for this vault later in the transaction")]
    MissingSettleInstruction,
    #[msg("Settle ran at a different instruction index than the one the ticket recorded")]
    SettleIndexMismatch,
    #[msg("Ticket does not match the accounts supplied to settle")]
    TicketMismatch,
    #[msg("The source leg lost more than the amount lent out")]
    SourceLegTampered,

    // --- depeg (spec §9.1) ---
    #[msg("Deviation has not reached the soft threshold")]
    DepegBelowThreshold,
    #[msg("Wrapper is not far enough from target to need rebalancing")]
    RebalanceNotNeeded,
    #[msg("Deviation has not persisted for min_duration")]
    DepegNotPersistent,
    #[msg("This wrapper has no on-chain price source, so a depeg cannot be proven")]
    NoWrapperPriceSource,
    #[msg("TWAP window does not match the configured window")]
    TwapWindowMismatch,
    #[msg("TWAP covers too many missing slots to be trusted")]
    /// No longer reachable: the depeg test reads an averaged price from the
    /// price account rather than a `TwapUpdate`, and there is no equivalent
    /// of a down-slots ratio. Kept so the numbering of every error after it
    /// is unchanged.
    TwapTooManyDownSlots,
    #[msg("This wrapper has no Pyth redemption-rate feed")]
    NoRedemptionRateFeed,
    #[msg("On-chain multiplier and Pyth redemption rate disagree beyond tolerance")]
    RedemptionRateDivergence,
    #[msg("Swap direction is wrong: must sell the rich wrapper and buy the cheap one")]
    DepegWrongDirection,

    // --- corporate actions (spec §8) ---
    #[msg("units_per_token move exceeds the unguarded limit and needs guardian co-sign")]
    UnitsPerTokenMoveNeedsGuardian,
    #[msg("Mint has a Scaled UI Amount extension but the wrapper is not configured to read it")]
    ScaledUiConfigMismatch,
    #[msg("Wrapper is configured for Scaled UI but the mint has no such extension")]
    ScaledUiExtensionMissing,

    // --- authority and configuration ---
    #[msg("Parameter out of range")]
    InvalidParameter,
    #[msg("Only the vault authority may do this")]
    NotAuthority,
    #[msg("Only the guardian or the authority may do this")]
    NotGuardian,
    #[msg("A guardian can only restrict, never move funds")]
    GuardianCannotDoThis,

    // --- NAV ---
    #[msg("NAV circuit breaker tripped")]
    NavCircuitBreaker,
    #[msg("Wrong number of wrapper accounts: NAV needs every registered wrapper")]
    IncompleteWrapperAccounts,
    #[msg("A supplied wrapper account does not match the on-chain registry")]
    WrapperAccountMismatch,

    #[msg("Index supply is zero; cannot derive nav_per_token")]
    ZeroSupply,
    #[msg("Computed a zero or negative mint amount")]
    ZeroMintAmount,
}
