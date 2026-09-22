/**
 * The shape `/api/devnet` returns: the deployment as it is right now.
 *
 * Kept apart from `devnet.ts`, which holds addresses, because the two have
 * different lifetimes. Addresses are generated at deploy time and committed;
 * everything here is a reading taken seconds ago and never stored.
 */

export interface LiveLeg {
  /** The mock's own handle, e.g. `mPAXG`. */
  key: string;
  /** The mainnet wrapper it stands in for, e.g. `Paxos PAXG`. */
  standsFor: string;
  /** That wrapper's registry key, e.g. `PAXG`. Used to find its logo. */
  mainnetKey: string;
  mint: string;
  tokenAccount: string;
  multiplierSource: string;
  /** Balance as the token program stores it, in whole tokens. */
  balance: number;
  /** Live Scaled UI multiplier off the mint, null where the mint has none. */
  multiplier: number | null;
  /** `balance * multiplier`: what NAV counts (invariant 5). */
  units: number;
  weightBps: number;
  targetWeightBps: number;
  /**
   * What one token of this holding trades at, from its liquidity pool.
   * Null when no pool exists for it.
   */
  marketPrice: number | null;
  /**
   * How far that price sits from what the token entitles the vault to.
   * Positive means the market pays more than the claim is worth.
   */
  premiumBps: number | null;
  /**
   * Where the price came from. `pyth` is the feed the on-chain check reads;
   * `pool` is our own liquidity, used only where the issuer publishes no
   * feed.
   */
  priceSource: 'pyth' | 'pool' | null;
}

/** Whether a newer price can be posted at all, and why not when it cannot. */
export interface OracleStatus {
  refreshable: boolean;
  reason: string | null;
}

/**
 * The vault's parameters, read from its account rather than restated from the
 * program's compiled defaults. `update_vault_config` can change any of these
 * after deployment, so the account is the only honest source.
 */
export interface VaultConfig {
  maxAgeSeconds: number;
  maxConfBps: number;
  feeMintBps: number;
  feeRedeemBps: number;
  marketClosedSurchargeBps: number;
  navBreakerBps: number;
  navBreakerWindowSeconds: number;
  softDepegBps: number;
  hardDepegBps: number;
  minDepegDurationSeconds: number;
  twapWindowSeconds: number;
  maxSwapBps: number;
  swapCooldownSeconds: number;
  callerRewardBps: number;
  rebalanceDriftBps: number;
  maxLossBps: number;
  minGainBps: number;
}

/** The last NAV the program recorded, in USD. */
export interface VaultNav {
  perToken: number;
  total: number;
  /** Unix seconds, 0 if `update_nav` has never run. */
  updatedTs: number;
  lastPermissionlessSwapTs: number;
}

export interface LiveVault {
  symbol: string;
  vault: string;
  indexMint: string;
  /** `ACTIVE`, `MARKET_CLOSED`, `PAUSED` or `HALTED`. */
  status: string;
  supply: number;
  feedLabel: string;
  /** Set when devnet reads a different feed than mainnet would. */
  standIn: string | null;
  priceAccount: string | null;
  price: number | null;
  priceAgeSeconds: number | null;
  /**
   * True when the price account is one Pyth maintains itself, rather than
   * one we posted. A sponsored account keeps updating with no operator and
   * no API key; ours only moves when somebody runs a script.
   */
  sponsored: boolean;
  maxWeightBps: number;
  config: VaultConfig | null;
  nav: VaultNav | null;
  legs: LiveLeg[];
  /**
   * What the supply would be had NAV read raw balances rather than Scaled UI
   * amounts. Null when no leg carries a multiplier, since then there is no
   * difference to show.
   */
  supplyIfRawRead: number | null;
}
