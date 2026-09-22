/**
 * The devnet liquidity pools, and what goes in them.
 *
 * Every pool pairs one holding against `mUSDC`, a mock dollar, on the SPL
 * Token Swap program. Pricing each pool against a dollar rather than against
 * every other holding keeps the count linear: ten holdings need ten pools,
 * not forty-five, and any pair is reachable in two hops.
 *
 * The quote side of each pool is the base amount times the price its Pyth
 * feed reported on 2026-09-22. Where a vault reads a substitute feed on
 * devnet, the pool inherits that substitute, so the pool and the vault agree
 * on what a holding is worth. They must: a pool priced differently from the
 * vault is a standing arbitrage that would drain one into the other.
 *
 * These are shallow on purpose. The deployer holds about 1.5 devnet SOL and
 * a limited mock supply, so the depth is enough to demonstrate a trade and
 * not enough to be a market. A large swap will move the price a long way,
 * which is honest behaviour for a small pool rather than a bug.
 *
 * The pools in this file are the Token Swap ones. The two Token-2022
 * holdings are not here and cannot be: the build deployed on devnet is the
 * older one, which takes a single token program for the whole pool and
 * rejects a Token-2022 mint outright with "the provided token program does
 * not match the token program expected by the swap". Tried on 2026-09-22
 * with mSPYx.
 *
 * They trade instead on Raydium's CPMM, which takes a token program per
 * side. Those two pools were opened on 2026-09-22 and live only in
 * `config/devnet.json`, tagged `kind: 'cpmm'`, because opening a pool is a
 * one-off fixture chore and what the product needs is the addresses.
 * `scripts/lib/pool.ts` and `frontend/src/lib/pool.ts` dispatch on the tag,
 * so nothing above them knows there are two venues.
 *
 * Every holding in every listed vault therefore has a pool, which is what
 * lets a deposit correct the basket: the panel buys whichever leg is
 * furthest below its target weight. Without a pool on the Scaled UI
 * holdings, a deposit into an equity vault could only buy the plain holding,
 * often the one already over target, and would increase concentration rather
 * than reduce it. The permissionless rebalance needs no pool either way.
 *
 * `scripts/devnet_reprice_pools.ts` keeps both venues in line with the
 * vaults they feed, and iterates over the deployment record rather than
 * over this list for exactly that reason.
 */

/** `mUSDC` decimals, matching real USDC. */
export const USDC_DECIMALS = 6;

export interface PoolPair {
  /** Stable identifier, used as the key in `config/devnet.json`. */
  key: string;
  /** The holding's key in `config/devnet_wrappers.ts`, or `wSOL`. */
  base: string;
  /** Base units to deposit. */
  baseAmount: number;
  /** mUSDC to deposit, which sets the opening price. */
  quoteAmount: number;
  /** The price this implies, for the record. */
  note: string;
}

export const POOL_PAIRS: PoolPair[] = [
  // The way in: devnet SOL buys mUSDC, and mUSDC buys everything else.
  { key: 'wSOL-mUSDC', base: 'wSOL', baseAmount: 0.4, quoteAmount: 47, note: 'SOL at $117.26' },

  // qGOLD. Three issuers of the same ounce, so three pools at the same price.
  { key: 'mPAXG-mUSDC', base: 'mPAXG', baseAmount: 5, quoteAmount: 21_600, note: 'gold at $4,320/oz' },
  { key: 'mXAUT-mUSDC', base: 'mXAUT', baseAmount: 5, quoteAmount: 21_600, note: 'gold at $4,320/oz' },
  { key: 'mGOLDoro-mUSDC', base: 'mGOLDoro', baseAmount: 5, quoteAmount: 21_600, note: 'gold at $4,320/oz' },

  // qSPY and qMSTR, whose vaults read substitute feeds on devnet; the pools
  // use the same substitutes so the two agree.
  { key: 'mSPYon-mUSDC', base: 'mSPYon', baseAmount: 100, quoteAmount: 11_726, note: 'substitute feed at $117.26' },
  { key: 'mMSTRbp-mUSDC', base: 'mMSTRbp', baseAmount: 2, quoteAmount: 172_056, note: 'substitute feed at $86,028' },

  // qSOL's plain holding.
  { key: 'mMSOL-mUSDC', base: 'mMSOL', baseAmount: 4, quoteAmount: 658, note: 'mSOL at $164.45' },
];
