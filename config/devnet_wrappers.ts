/**
 * The mock wrapper lineup for devnet.
 *
 * None of the nine real wrappers exist on devnet, and there is no way to
 * bring them there: they are issuer-controlled mainnet mints. So devnet gets
 * mints we create, shaped to match the property of the real token that the
 * program actually cares about.
 *
 * What the program cares about is exactly two things per wrapper: which token
 * program owns the mint, and whether the mint carries a Scaled UI Amount
 * config. `register_wrapper` cross-checks the second against the declared
 * `multiplier_source` and refuses a mismatch, so a mock that gets this wrong
 * is rejected on-chain rather than quietly mispriced. Everything else about a
 * wrapper (issuer, supply, liquidity) is off-chain context the program never
 * reads.
 *
 * What the mocks therefore reproduce faithfully:
 *
 *   - xStocks legs are Token-2022 with a live Scaled UI multiplier, which is
 *     what invariant 5 (`README.md`) is about. `initialMultiplier` is set
 *     above 1.0 from the start, so a NAV read that ignores the multiplier
 *     gives a visibly wrong answer rather than an accidentally right one.
 *   - Fixed and keeper-pushed legs are plain SPL Token mints with no
 *     extension, which is what PAXG and XAUt0 are.
 *
 * What they cannot reproduce: real issuer behaviour. A mock never freezes an
 * account, never exercises a permanent delegate, and never pays a dividend on
 * its own. Those paths are covered by the litesvm tests, which can fabricate
 * account state directly, and remain untested against a live issuer. See the
 * untested list in `README.md`.
 *
 * Weight caps: `Quorum_Spec_v5.pdf` §4 sets 4000bps, which assumes at least
 * three issuers. A two-leg vault cannot satisfy it, since two legs capped at
 * 40% cover only 80% of the basket, so the two-issuer vaults use 6000bps.
 * This is the same reasoning the mainnet config uses.
 */
import { MULTIPLIER, UNIT } from '../scripts/lib/codec.js';

/** One unit: one share, or one troy ounce. Matches `UNIT_SCALE` in the program. */
export const UNIT_SCALE = 1_000_000_000n;

export interface MockWrapper {
  /** Short handle, used as the mint's local key in `config/devnet.json`. */
  key: string;
  /** The mainnet wrapper this stands in for, for display. */
  standsFor: string;
  /** Its `key` in `config/wrappers.ts`, so the UI can join the two registries. */
  mainnetKey: string;
  decimals: number;
  /** `MULTIPLIER.*`. Decides which token program and extensions are needed. */
  multiplierSource: number;
  /**
   * Scaled UI multiplier to initialise the mint with. Only meaningful for a
   * `Token2022ScaledUi` wrapper; set above 1.0 so the raw-balance bug shows.
   */
  initialMultiplier?: number;
  unitsPerToken: bigint;
  targetWeightBps: number;
  /** How much to mint to the deployer, in whole tokens, for seeding and demos. */
  supply: number;
  /**
   * Pyth feed for the real wrapper this mock stands in for.
   *
   * The depeg test compares this against the underlying's own feed, both
   * averaged. Where the issuer publishes a feed, using it is the faithful
   * thing: a mock standing in for PAXG is judged depegged exactly when PAXG
   * is.
   */
  wrapperFeedId?: string;
  /**
   * True when `wrapperFeedId` is the vault's own underlying rather than a
   * price for this token.
   *
   * Oro, Ondo and Backpack publish nothing, and no close substitute exists:
   * the gold indices are not on this entitlement, and SPYG trades at $124
   * against SPY's $774, so it would read as a permanent 84% depeg. Pointing
   * these at the underlying keeps the demo uniform, at a cost that has to be
   * stated: fair value for these wrappers is one times the underlying, so
   * comparing the underlying against itself gives a deviation of exactly
   * zero and `check_depeg` returns Healthy whatever the token does.
   *
   * It is a fixture, not a design. On mainnet these three must be left unset
   * so the program refuses to act rather than reporting a clean bill it did
   * not earn.
   */
  feedIsUnderlying?: boolean;
  /**
   * Pyth redemption-rate feed, for a wrapper whose mint carries a live
   * multiplier. `verify_redemption_rate` compares the two and quarantines a
   * mint that disagrees with Pyth by more than 50bps, which is what turns
   * invariant 5 from something the program implements into something it can
   * be held to.
   */
  rrFeedId?: string;
  /**
   * An existing mint to register instead of creating one.
   *
   * Set for wrapped SOL, which already exists on every cluster and cannot be
   * minted by us. It is the one wrapper a visitor can obtain without a
   * faucet, since wrapping is just a transfer plus a sync, which is what
   * makes depositing real devnet SOL possible.
   */
  existingMint?: string;
  /** Whole tokens to seed, when 10 of them would be absurd. Defaults to 10. */
  seedTokens?: number;
}

export interface MockVault {
  symbol: string;
  unit: number;
  maxWeightBps: number;
  wrappers: MockWrapper[];
  /**
   * Whether the site shows this vault. Defaults to true.
   *
   * A vault cannot be un-deployed: there is no close instruction, and the
   * rent is spent either way. So one that is no longer wanted on the site is
   * marked here rather than deleted, which keeps the config honest about
   * what exists on chain while `scripts/sync_frontend_devnet.ts` keeps it out
   * of the frontend.
   */
  listed?: boolean;
}

export const MOCK_VAULTS: MockVault[] = [
  {
    // The only vault a visitor can enter with an asset they already hold.
    // Wrapped SOL needs no faucet, and the two staked legs carry the
    // exchange rates their real counterparts actually trade at, so the
    // basket arithmetic is the same shape as the production one.
    symbol: 'qSOL',
    // Unlisted. The hackathon is about tokenized equities, and SOL is not a
    // real-world asset, so this sat at the front of the lineup arguing
    // against the pitch. Still deployed and still working; simply not shown.
    listed: false,
    unit: UNIT.Share,
    maxWeightBps: 4000,
    wrappers: [
      {
        key: 'wSOL',
        mainnetKey: 'wSOL',
        standsFor: 'Wrapped SOL',
        existingMint: 'So11111111111111111111111111111111111111112',
        decimals: 9,
        multiplierSource: MULTIPLIER.Fixed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 3334,
        supply: 0,
        seedTokens: 0.3,
      },
      {
        key: 'mJitoSOL',
        mainnetKey: 'jitoSOL',
        standsFor: 'Jito jitoSOL',
        decimals: 9,
        multiplierSource: MULTIPLIER.Token2022ScaledUi,
        // Jito's live redemption rate, from Crypto.JITOSOL/USD over
        // Crypto.SOL/USD on 2026-09-22. A staked-SOL token is the clearest
        // real case for the Scaled UI multiplier: one token is worth more
        // than one SOL and the gap is the staking yield.
        initialMultiplier: 1.301792,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 3333,
        supply: 10,
        seedTokens: 0.25,
      },
      {
        key: 'mMSOL',
        mainnetKey: 'mSOL',
        standsFor: 'Marinade mSOL',
        decimals: 9,
        multiplierSource: MULTIPLIER.KeeperPushed,
        // Marinade's live rate, same sources and date. Pushed rather than
        // read off the mint, which is the other half of invariant 5.
        unitsPerToken: 1_403_157_000n,
        targetWeightBps: 3333,
        supply: 10,
        seedTokens: 0.2,
      },
    ],
  },
  {
    symbol: 'qSPY',
    unit: UNIT.Share,
    maxWeightBps: 6000,
    wrappers: [
      {
        key: 'mSPYx',
        mainnetKey: 'SPYx',
        wrapperFeedId: '0x2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14',
        rrFeedId: '0x9e916cc00d292da2367646ffd6537d6b8d0c3f15e2d5891ac44aed31291811a9',
        standsFor: 'xStocks SPYx',
        decimals: 8,
        multiplierSource: MULTIPLIER.Token2022ScaledUi,
        // Roughly a year of reinvested SPY dividends. A NAV read that misses
        // the multiplier is short by 1.3%, which no rounding can excuse.
        initialMultiplier: 1.013,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 5000,
        supply: 1000,
      },
      {
        key: 'mSPYon',
        wrapperFeedId: '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
        feedIsUnderlying: true,
        mainnetKey: 'SPYon',
        standsFor: 'Ondo SPYon',
        decimals: 9,
        multiplierSource: MULTIPLIER.KeeperPushed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 5000,
        supply: 1000,
      },
    ],
  },
  {
    symbol: 'qMSTR',
    unit: UNIT.Share,
    maxWeightBps: 6000,
    wrappers: [
      {
        key: 'mMSTRx',
        mainnetKey: 'MSTRx',
        wrapperFeedId: '0x53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28',
        rrFeedId: '0x342df7ea9b8db28630933d55d0c9c1119525eb5be58d499ecc4e88faf061083a',
        standsFor: 'xStocks MSTRx',
        decimals: 8,
        multiplierSource: MULTIPLIER.Token2022ScaledUi,
        initialMultiplier: 1.0009180758,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 5000,
        supply: 1000,
      },
      {
        key: 'mMSTRbp',
        wrapperFeedId: '0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09',
        feedIsUnderlying: true,
        mainnetKey: 'MSTRbp',
        standsFor: 'Backpack MSTRbp',
        decimals: 6,
        multiplierSource: MULTIPLIER.KeeperPushed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 5000,
        supply: 1000,
      },
    ],
  },
  {
    symbol: 'qGOLD',
    unit: UNIT.Ounce,
    maxWeightBps: 4000,
    wrappers: [
      {
        key: 'mPAXG',
        mainnetKey: 'PAXG',
        wrapperFeedId: '0x273717b49430906f4b0c230e99aa1007f83758e3199edbc887c0d06c3e332494',
        standsFor: 'Paxos PAXG',
        decimals: 8,
        multiplierSource: MULTIPLIER.Fixed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 3334,
        supply: 100,
      },
      {
        key: 'mXAUT',
        mainnetKey: 'XAUt0',
        wrapperFeedId: '0x44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67',
        standsFor: 'Tether XAUt0',
        decimals: 6,
        multiplierSource: MULTIPLIER.Fixed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 3333,
        supply: 100,
      },
      {
        key: 'mGOLDoro',
        wrapperFeedId: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
        feedIsUnderlying: true,
        mainnetKey: 'GOLD',
        standsFor: 'Oro GOLD',
        decimals: 9,
        multiplierSource: MULTIPLIER.KeeperPushed,
        unitsPerToken: UNIT_SCALE,
        targetWeightBps: 3333,
        supply: 100,
      },
    ],
  },
];

/** Shape of `config/devnet.json`, written by `scripts/devnet_mocks.ts`. */
export interface DevnetState {
  cluster: 'devnet';
  programId: string;
  authority: string;
  createdAt: string;
  /** Mock wrapper key to mint address. */
  mints: Record<string, string>;
  /** Vault symbol to its PDA and index mint. */
  vaults: Record<string, { vault: string; indexMint: string }>;
  /** Vault symbol to the posted Pyth `PriceUpdateV2` account. */
  priceUpdates: Record<string, string>;
  /** Feed id to its posted price account, for wrapper and redemption-rate feeds. */
  wrapperPrices?: Record<string, string>;
  /** Pool key to its on-chain accounts, written by `scripts/devnet_pools.ts`. */
  pools?: Record<string, {
    pair: string;
    swapAccount: string;
    authority: string;
    poolMint: string;
    tokenA: string;
    tokenB: string;
    mintA: string;
    mintB: string;
    feeAccount: string;
    programA: string;
    programB: string;
    decimalsA: number;
  }>;
}
