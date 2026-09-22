use anchor_lang::prelude::*;

/// What one unit of account means for a vault (`Quorum_Spec_v5.pdf` §4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unit {
    /// One share of the underlying equity (NVDA, SPY).
    Share,
    /// One troy ounce (XAU).
    Ounce,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum VaultStatus {
    Active,
    /// The underlying market is closed. Higher fees, swap-and-mint capped, no
    /// rebalance. In-kind redeem stays open, which is the "exit is always
    /// open" guarantee.
    MarketClosed,
    /// Nothing but in-kind redeem. Unpausing needs the full authority multisig.
    Paused,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum WrapperStatus {
    Active,
    /// Soft depeg: no new deposits of this wrapper, but it still counts in NAV
    /// and `swap_depegged` is open to anyone.
    MintDisabled,
    /// Hard depeg: haircut applied in NAV, dropped from `allowed_out` so nobody
    /// can route value into a broken issuer. Still paid out on redeem.
    Quarantined,
    /// The issuer has frozen the vault's token account, or transfers fail for
    /// any other reason. Counted as zero in NAV and skipped by in-kind redeem,
    /// so one stuck leg cannot block every holder's exit. The forfeited share
    /// stays in the vault for whoever holds when it thaws. The guardian may set
    /// it; only the authority may clear it.
    Frozen,
}

impl WrapperStatus {
    /// Strict ordering of restriction. Permissionless paths may only move a
    /// wrapper up this scale; only the authority may move it down.
    pub fn severity(self) -> u8 {
        match self {
            WrapperStatus::Active => 0,
            WrapperStatus::MintDisabled => 1,
            WrapperStatus::Quarantined => 2,
            WrapperStatus::Frozen => 3,
        }
    }
}

/// How the underlying units behind one wrapper token change over time (spec
/// §8).
///
/// Picking `Fixed` for a wrapper that carries a Scaled UI multiplier means
/// reading the raw balance, which undervalues NAV after every dividend and
/// over-mints index tokens. `register_wrapper` rejects that combination rather
/// than trusting this field alone (invariant 5 in `README.md`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MultiplierSource {
    /// `units_per_token` is constant. PAXG, XAUt0, and Ondo (whose balance
    /// grows instead).
    Fixed,
    /// Read the Token-2022 Scaled UI Amount multiplier off the mint. xStocks.
    Token2022ScaledUi,
    /// The keeper pushes the multiplier on-chain, guarded by the 1% co-sign
    /// rule.
    KeeperPushed,
}

/// One per asset. Holds the registry, the guards and the index mint.
#[account]
#[derive(Debug)]
pub struct Vault {
    pub bump: u8,
    /// Ticker, e.g. "qNVDA". Padded, see `symbol_str`.
    pub symbol: [u8; 12],
    pub unit: Unit,
    pub status: VaultStatus,

    pub authority: Pubkey,
    /// Can pause and quarantine. Can never move funds (invariant 6).
    pub guardian: Pubkey,

    pub index_mint: Pubkey,
    pub index_mint_bump: u8,

    /// Pyth feed id for the real asset, never for a wrapper.
    pub underlying_feed_id: [u8; 32],
    pub max_age_seconds: u64,
    pub max_conf_bps: u16,

    pub fee_mint_bps: u16,
    pub fee_redeem_bps: u16,
    /// Added to swap-path fees while the market is closed (spec §10).
    pub market_closed_surcharge_bps: u16,

    /// Spec §9.2 circuit breaker.
    pub nav_breaker_bps: u16,
    pub nav_breaker_window_seconds: i64,

    /// Spec §9.1 depeg thresholds and permissionless-swap bounds.
    pub soft_depeg_bps: u16,
    pub hard_depeg_bps: u16,
    pub min_depeg_duration_seconds: i64,
    /// Window the depeg TWAP must cover, enforced by Pyth's own check.
    pub twap_window_seconds: u64,
    /// Max fraction of the vault one permissionless swap may move.
    pub max_swap_bps: u16,
    pub swap_cooldown_seconds: i64,
    /// Share of the realised gain paid to whoever calls swap_depegged.
    pub caller_reward_bps: u16,
    /// Drift from target weight that opens `rebalance` (in bps, spec §7: 5pp).
    pub rebalance_drift_bps: u16,
    /// `rebalance` may not cost the basket more than this.
    pub max_loss_bps: u16,
    /// `swap_depegged` must gain at least this much.
    pub min_gain_bps: u16,

    /// Registered wrappers, in registration order. `allowed_out` is derived
    /// from this list at call time, never from caller input (invariant 3).
    pub wrapper_count: u8,
    pub wrappers: [Pubkey; Vault::MAX_WRAPPERS],

    /// The observation the circuit breaker measures against. Advances only once
    /// the window has elapsed, so the test is "against a point up to a window
    /// ago" rather than "against the previous call".
    pub nav_anchor_per_token: u128,
    pub nav_anchor_ts: i64,

    /// Vault-wide cooldown for the permissionless swaps. Per-wrapper alone can
    /// be rotated around by declaring a different source each call.
    pub last_permissionless_swap_ts: i64,

    /// Last NAV observation, used by the circuit breaker (spec §9.2).
    pub nav_per_token: u128,
    pub nav_total: u128,
    pub nav_updated_slot: u64,
    pub nav_updated_ts: i64,

    pub reserved: [u8; 64],
}

impl Vault {
    pub const MAX_WRAPPERS: usize = 8;

    /// 8 discriminator + fields. Over-allocated deliberately; `reserved`
    /// absorbs drift.
    pub const LEN: usize = 8
        + 1                          // bump
        + 12                         // symbol
        + 1 + 1                      // unit, status
        + 32 + 32                    // authority, guardian
        + 32 + 1                     // index_mint, bump
        + 32 + 8 + 2                 // feed id, max_age, max_conf
        + 2 + 2 + 2                  // fees, surcharge
        + 2 + 8                      // nav breaker
        + 2 + 2 + 8 + 8 + 2 + 8 + 2 + 2 + 2 + 2  // depeg + twap + permissionless bounds
        + 1 + (32 * Self::MAX_WRAPPERS)
        + 16 + 8                     // nav_anchor_per_token, nav_anchor_ts
        + 8                          // last_permissionless_swap_ts
        + 16 + 16 + 8 + 8            // nav_per_token, nav_total, slot, ts
        + 64;

    /// The symbol bytes without trailing padding, for PDA seed derivation.
    pub fn symbol_seed(&self) -> &[u8] {
        let end = self
            .symbol
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(self.symbol.len());
        &self.symbol[..end]
    }

    /// The PDA signer for CPIs the vault authorises. One definition, so the
    /// seed order can only be wrong in one place.
    pub fn signer(&self) -> VaultSigner {
        VaultSigner {
            symbol: self.symbol,
            len: self.symbol_seed().len(),
            bump: [self.bump],
        }
    }

    pub fn is_registered(&self, mint: &Pubkey) -> bool {
        self.wrappers[..self.wrapper_count as usize].contains(mint)
    }

    /// Swap paths are blocked when the vault is paused; in-kind redeem is not.
    pub fn swaps_allowed(&self) -> bool {
        matches!(self.status, VaultStatus::Active)
    }
}

/// One per wrapper per vault.
#[account]
#[derive(Debug)]
pub struct WrapperConfig {
    pub bump: u8,
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    /// PDA-owned token account holding this wrapper's balance.
    pub vault_token_account: Pubkey,
    pub decimals: u8,
    /// True if the mint is owned by Token-2022 rather than the legacy SPL
    /// program.
    pub is_token_2022: bool,

    /// Underlying units one whole wrapper token represents, at `UNIT_SCALE`.
    /// For `Token2022ScaledUi` this is the base and the live mint multiplier is
    /// applied on top at read time.
    pub units_per_token: u128,
    pub multiplier_source: MultiplierSource,

    pub target_weight_bps: u16,
    pub max_weight_bps: u16,
    pub status: WrapperStatus,
    /// Applied to this wrapper's contribution to NAV while QUARANTINED.
    pub haircut_bps: u16,

    /// Pool account used for the depeg TWAP (spec §9.1). `None` while unset.
    pub dex_price_source: Pubkey,
    /// Pyth feed for the wrapper itself, if one exists. Preferred over a pool
    /// TWAP.
    pub wrapper_feed_id: [u8; 32],
    pub has_wrapper_feed: bool,

    /// Pyth redemption-rate feed (`Crypto.<WRAPPER>/<UNDERLYING>.RR`).
    ///
    /// Publishes how much underlying one wrapper token redeems for: the same
    /// quantity as `units_per_token`, measured by an oracle instead of read
    /// off the mint. Holding both lets the program cross-check them at
    /// runtime, which makes an invariant 5 regression loud rather than
    /// silent.
    pub rr_feed_id: [u8; 32],
    pub has_rr_feed: bool,
    /// Last observed redemption rate, fixed point at UNIT_SCALE.
    pub last_rr: u128,
    pub last_rr_ts: i64,

    /// Depeg persistence tracking: when the deviation first crossed the soft
    /// threshold, and in which direction. Zero means "not currently deviating".
    pub depeg_since_ts: i64,
    pub depeg_direction: i8,

    /// Cooldown bookkeeping for permissionless swaps.
    pub last_permissionless_swap_ts: i64,

    /// Risk flags recorded at registration (spec §9.2 "permanent delegate /
    /// freeze").
    pub has_freeze_authority: bool,
    pub has_permanent_delegate: bool,
    pub has_transfer_hook: bool,

    pub reserved: [u8; 64],
}

/// Fixtures only. A real `Vault` is written by `initialize_vault`.
#[cfg(test)]
impl Default for Vault {
    fn default() -> Self {
        Self {
            bump: 0,
            symbol: [0u8; 12],
            unit: Unit::Share,
            status: VaultStatus::Active,
            authority: Pubkey::default(),
            guardian: Pubkey::default(),
            index_mint: Pubkey::default(),
            index_mint_bump: 0,
            underlying_feed_id: [0u8; 32],
            max_age_seconds: crate::constants::DEFAULT_MAX_AGE_SECONDS,
            max_conf_bps: crate::constants::DEFAULT_MAX_CONF_BPS,
            fee_mint_bps: crate::constants::DEFAULT_FEE_MINT_BPS,
            fee_redeem_bps: crate::constants::DEFAULT_FEE_REDEEM_BPS,
            market_closed_surcharge_bps: 30,
            nav_breaker_bps: crate::constants::DEFAULT_NAV_BREAKER_BPS,
            nav_breaker_window_seconds: crate::constants::DEFAULT_NAV_BREAKER_WINDOW_SECONDS,
            soft_depeg_bps: crate::constants::DEFAULT_SOFT_DEPEG_BPS,
            hard_depeg_bps: crate::constants::DEFAULT_HARD_DEPEG_BPS,
            min_depeg_duration_seconds: crate::constants::DEFAULT_MIN_DEPEG_DURATION_SECONDS,
            twap_window_seconds: crate::constants::DEFAULT_TWAP_WINDOW_SECONDS,
            max_swap_bps: crate::constants::DEFAULT_MAX_SWAP_BPS,
            swap_cooldown_seconds: crate::constants::DEFAULT_SWAP_COOLDOWN_SECONDS,
            caller_reward_bps: crate::constants::DEFAULT_CALLER_REWARD_BPS,
            rebalance_drift_bps: crate::constants::DEFAULT_REBALANCE_DRIFT_BPS,
            max_loss_bps: crate::constants::DEFAULT_MAX_LOSS_BPS,
            min_gain_bps: crate::constants::DEFAULT_MIN_GAIN_BPS,
            wrapper_count: 0,
            wrappers: [Pubkey::default(); Vault::MAX_WRAPPERS],
            nav_anchor_per_token: 0,
            nav_anchor_ts: 0,
            last_permissionless_swap_ts: 0,
            nav_per_token: 0,
            nav_total: 0,
            nav_updated_slot: 0,
            nav_updated_ts: 0,
            reserved: [0u8; 64],
        }
    }
}

/// Fixtures only. A real `WrapperConfig` is written by `register_wrapper`.
#[cfg(test)]
impl Default for WrapperConfig {
    fn default() -> Self {
        Self {
            bump: 0,
            vault: Pubkey::default(),
            wrapper_mint: Pubkey::default(),
            vault_token_account: Pubkey::default(),
            decimals: 6,
            is_token_2022: false,
            units_per_token: crate::constants::UNIT_SCALE,
            multiplier_source: MultiplierSource::Fixed,
            target_weight_bps: 0,
            max_weight_bps: 0,
            status: WrapperStatus::Active,
            haircut_bps: 0,
            dex_price_source: Pubkey::default(),
            wrapper_feed_id: [0u8; 32],
            has_wrapper_feed: false,
            rr_feed_id: [0u8; 32],
            has_rr_feed: false,
            last_rr: 0,
            last_rr_ts: 0,
            depeg_since_ts: 0,
            depeg_direction: 0,
            last_permissionless_swap_ts: 0,
            has_freeze_authority: false,
            has_permanent_delegate: false,
            has_transfer_hook: false,
            reserved: [0u8; 64],
        }
    }
}

/// One in-flight permissionless swap, opened by `begin_swap` and closed by
/// `end_swap` in the same transaction.
///
/// The ticket carries the state the settle has to check against and, because
/// it is a PDA of the vault, it also makes a second concurrent loan
/// impossible: the `init` fails while one is outstanding. It is not the
/// safety property on its own. If the settle were simply left out of the
/// transaction the ticket would survive as evidence and the tokens would be
/// gone, which is why `begin_swap` proves by introspection that a settle
/// exists below it.
#[account]
#[derive(Debug)]
pub struct SwapTicket {
    pub bump: u8,
    pub vault: Pubkey,
    pub caller: Pubkey,
    /// 0 = rebalance, 1 = swap_depegged.
    pub kind: u8,
    pub source_mint: Pubkey,
    pub dest_mint: Pubkey,
    /// Source tokens handed to the caller, measured rather than requested.
    pub source_lent_raw: u64,
    /// Gross underlying units those tokens carried, at `UNITS_SCALE`.
    pub source_gross_sold: u128,
    /// Gross units the destination leg must gain for the settle to pass.
    pub min_dest_gross: u128,
    /// Whole-basket gross units before the loan left.
    pub total_gross_before: u128,
    /// Source vault balance immediately after the loan, so the settle can see
    /// whether anything else took from that leg in between.
    pub source_balance_after: u64,
    /// Destination vault balance when the ticket opened.
    pub dest_balance_before: u64,
    /// Priced at the open, so the caller reward cannot be moved by choosing
    /// when to settle.
    pub nav_per_token_before: u128,
    pub unit_price_fp: u128,
    /// The settle must run at exactly this top-level instruction index.
    pub expected_end_index: u16,
}

impl SwapTicket {
    pub const LEN: usize = 8
        + 1 + 32 + 32 + 1        // bump, vault, caller, kind
        + 32 + 32                // source_mint, dest_mint
        + 8 + 16 + 16 + 16       // lent, sold, min_dest, total_before
        + 8 + 8                  // source_balance_after, dest_balance_before
        + 16 + 16                // nav_per_token_before, unit_price_fp
        + 2; // expected_end_index
}

/// Owns the seed bytes so the `&[&[u8]]` a CPI needs can borrow from it.
pub struct VaultSigner {
    symbol: [u8; 12],
    len: usize,
    bump: [u8; 1],
}

impl VaultSigner {
    pub fn seeds(&self) -> [&[u8]; 3] {
        [
            crate::constants::VAULT_SEED,
            &self.symbol[..self.len],
            &self.bump,
        ]
    }
}

impl WrapperConfig {
    /// Tighten a wrapper's status from a permissionless path, returning whether
    /// anything changed.
    ///
    /// Only ever moves up `severity`, so a caller cannot knock a leg the
    /// guardian froze back down to Quarantined, which would put a frozen
    /// account back into the redeem payout and revert every holder's exit.
    pub fn escalate(&mut self, to: WrapperStatus) -> bool {
        if to.severity() <= self.status.severity() {
            return false;
        }
        self.status = to;
        if matches!(to, WrapperStatus::Quarantined) && self.haircut_bps == 0 {
            self.haircut_bps = crate::constants::DEFAULT_HAIRCUT_BPS;
        }
        true
    }

    /// Whether new value may enter this wrapper. The mint paths ask here.
    pub fn require_mintable(&self) -> Result<()> {
        match self.status {
            WrapperStatus::Active => Ok(()),
            WrapperStatus::MintDisabled => {
                Err(error!(crate::errors::QuorumError::WrapperMintDisabled))
            }
            WrapperStatus::Quarantined => {
                Err(error!(crate::errors::QuorumError::WrapperQuarantined))
            }
            WrapperStatus::Frozen => Err(error!(crate::errors::QuorumError::WrapperFrozen)),
        }
    }

    pub const LEN: usize = 8
        + 1
        + 32
        + 32
        + 32
        + 1
        + 1
        + 16
        + 1
        + 2
        + 2
        + 1
        + 2
        + 32
        + 32
        + 1
        + 32
        + 1
        + 16
        + 8
        + 8
        + 1
        + 8
        + 1
        + 1
        + 1
        + 64;

    pub fn is_active(&self) -> bool {
        matches!(self.status, WrapperStatus::Active)
    }

    /// Spec §6.4: quarantined wrappers drop out of `allowed_out` automatically
    /// (invariant 3).
    pub fn allowed_as_swap_output(&self) -> bool {
        matches!(self.status, WrapperStatus::Active)
    }

    /// How much of this wrapper's value NAV withholds.
    pub fn nav_haircut_bps(&self) -> u16 {
        match self.status {
            WrapperStatus::Quarantined => self.haircut_bps,
            // Worth nothing until it moves again. Redeem skips it for the same
            // reason, so the two paths cannot disagree about its value.
            WrapperStatus::Frozen => 10_000,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(status: WrapperStatus) -> WrapperConfig {
        WrapperConfig {
            status,
            ..Default::default()
        }
    }

    /// `check_depeg` is permissionless, so a caller who could downgrade a
    /// frozen leg to Quarantined would put a frozen account back into the
    /// redeem payout and brick every exit.
    #[test]
    fn escalate_never_lowers_severity() {
        let mut c = w(WrapperStatus::Frozen);
        assert!(!c.escalate(WrapperStatus::Quarantined));
        assert!(matches!(c.status, WrapperStatus::Frozen));

        let mut c = w(WrapperStatus::Quarantined);
        assert!(!c.escalate(WrapperStatus::MintDisabled));
        assert!(matches!(c.status, WrapperStatus::Quarantined));
    }

    #[test]
    fn escalate_tightens_and_sets_a_haircut_once() {
        let mut c = w(WrapperStatus::Active);
        assert!(c.escalate(WrapperStatus::MintDisabled));
        assert_eq!(c.haircut_bps, 0, "a mint stop is not a valuation call");

        assert!(c.escalate(WrapperStatus::Quarantined));
        assert_eq!(c.haircut_bps, crate::constants::DEFAULT_HAIRCUT_BPS);

        // An authority-set haircut is not overwritten by a later escalation.
        c.haircut_bps = 2_500;
        c.status = WrapperStatus::MintDisabled;
        assert!(c.escalate(WrapperStatus::Quarantined));
        assert_eq!(c.haircut_bps, 2_500);
    }

    #[test]
    fn escalate_is_a_no_op_at_the_same_status() {
        let mut c = w(WrapperStatus::Quarantined);
        assert!(!c.escalate(WrapperStatus::Quarantined));
    }
}
