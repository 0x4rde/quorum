/**
 * The wrapper registry: the nine tokens the three v1 vaults may ever hold.
 *
 * Every mint address in here is load-bearing and gets verified on mainnet by
 * `scripts/verify_wrappers.ts`. A wrong address is not a bug that shows up in a
 * test, it is a vault holding the wrong asset, so nothing goes in this file
 * without a source, and nothing is trusted until the audit has run against it.
 */

/** How the underlying units behind one wrapper token change over time (`Quorum_Spec_v5.pdf` §8). */
export type MultiplierSource =
  /** 1 token = a constant number of units. PAXG, XAUt0. */
  | 'FIXED'
  /** Token-2022 Scaled UI Amount multiplier. xStocks. See invariant 5 in `README.md`. */
  | 'TOKEN2022_SCALED_UI'
  /** Keeper pushes the multiplier on-chain. Anything undocumented. */
  | 'KEEPER_PUSHED';

export type Confidence = 'high' | 'medium' | 'unverified';

export interface WrapperEntry {
  /** Short handle used in logs and docs. */
  key: string;
  issuer: string;
  /** Mainnet-beta mint. `null` means research has not produced a trustworthy address yet. */
  mint: string | null;
  /** Where the address came from. Required whenever `mint` is set. */
  source?: string;
  confidence: Confidence;
  /**
   * False when the token exists on-chain but cannot actually be held or traded
   * (zero supply, issuer-disabled transfers, no route). Dark wrappers stay in
   * this file as documentation and are NOT registered on-chain in v1.
   */
  live: boolean;
  /** Measured Jupiter price impact, from the depth scan. Why a wrapper is in or out. */
  depthNote?: string;
  multiplierSource: MultiplierSource;
  /** What the issuer documents about dividends. `null` = the issuer has published nothing. */
  dividendMechanism: string | null;
  notes?: string;
}

export interface VaultEntry {
  /** Index token ticker. */
  symbol: string;
  /** The real-world asset the vault tracks. */
  underlying: string;
  /** SHARE or OUNCE (spec §4). */
  unit: 'SHARE' | 'OUNCE';
  /** Pyth feed id (32-byte hex) for the underlying, NOT for any wrapper. */
  pythFeedId: string | null;
  wrappers: WrapperEntry[];
}

export const VAULTS: VaultEntry[] = [
  {
    // The flagship. The only underlying anywhere on Solana with three live
    // issuers that are ALL deep: every leg prices a $10k buy inside 0.5%.
    // This is the vault that actually demonstrates "no single-issuer risk".
    symbol: 'qGOLD',
    underlying: 'XAU',
    unit: 'OUNCE',
    pythFeedId: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
    wrappers: [
      {
        key: 'PAXG',
        issuer: 'Paxos',
        mint: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW',
        source: 'On-chain metadata URI -> token-metadata.paxos.com. Native Paxos issuance, NOT the Wormhole bridge.',
        confidence: 'high',
        live: true,
        depthNote: '<0.01% price impact on a $10k buy',
        multiplierSource: 'FIXED',
        dividendMechanism: 'None. 1 token = 1 troy ounce, zero storage fee.',
        notes:
          'TransferFeeConfig present at 0 bps with an authority that can raise it. Invariant 2 (measured deltas) covers this, but never assume amount_sent == amount_received.',
      },
      {
        key: 'XAUt0',
        issuer: 'Tether',
        mint: 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P',
        source:
          'Confirmed against usdt0.to by the team, 2026-09-20. Corroborated by CoinGecko tether-gold detail_platforms.solana, the Jupiter verified list and Coinbase.',
        confidence: 'high',
        live: true,
        depthNote: '<0.01% at $2k, 0.02% at $10k',
        multiplierSource: 'FIXED',
        dividendMechanism: 'None. 1 token = 1 troy ounce.',
        notes:
          'Human-verified against the issuer site. Note it is the only mint in the registry with no issuer-controlled metadata URI, so re-verification is manual rather than automatic - verify_wrappers cannot re-check this one.',
      },
      {
        key: 'GOLD',
        issuer: 'Oro',
        mint: 'GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A',
        source: 'CoinGecko contract lookup -> oro.finance; Jupiter verified; vanity deployer. Oro docs do not publish the address.',
        confidence: 'medium',
        live: true,
        depthNote: '0.44% at $2k, 0.51% at $10k',
        multiplierSource: 'FIXED',
        dividendMechanism: null,
        notes:
          'Plain SPL, no extensions, no freeze authority - least restricted of the set. But "yield-bearing gold" is unexplained; if the yield is a rebase, FIXED is still correct.',
      },
    ],
  },
  {
    // The deepest equity pair on Solana, and the demo lead. Backpack's SPY is
    // provisioned but dark, so the third slot stays reserved.
    symbol: 'qSPY',
    underlying: 'SPY',
    unit: 'SHARE',
    pythFeedId: '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
    wrappers: [
      {
        key: 'SPYx',
        issuer: 'xStocks (Backed Finance)',
        mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
        source: 'On-chain metadata URI -> xstocks-metadata.backed.fi; Jupiter verified',
        confidence: 'high',
        live: true,
        depthNote: '<0.01% at $10k, the deepest equity leg measured',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism: 'Reinvested net of withholding into the Scaled UI multiplier. Verified on-chain at 1.0039092400.',
      },
      {
        key: 'SPYon',
        issuer: 'Ondo Global Markets',
        mint: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo',
        source: 'On-chain metadata URI -> app.ondo.finance API; Jupiter verified',
        confidence: 'high',
        live: true,
        depthNote: '0.08% at $10k - the only deep Ondo leg on Solana',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism:
          'CONTRADICTS `Quorum_Spec_v5.pdf` §8. Spec says Ondo reinvests as extra tokens with units_per_token fixed at 1. A mainnet read shows a live ScaledUiAmountConfig at 1.0094730728.',
      },
      {
        key: 'SPYbp',
        issuer: 'Backpack Securities',
        mint: 'SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi',
        source: 'api.backpack.exchange /api/v1/assets SPY.US; confirmed via RPC',
        confidence: 'high',
        live: false,
        depthNote: 'no route - supply 0',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism: null,
        notes: 'DARK: supply 0, deposits/withdrawals disabled by issuer. Not registered in v1; the registry slot is reserved.',
      },
    ],
  },
  {
    // Third vault, chosen on measured depth rather than reputation: MSTR is the
    // only other underlying where two issuers both price a $10k buy under 0.01%.
    // Deliberately a DIFFERENT issuer pair from qSPY (xStocks+Backpack rather
    // than xStocks+Ondo), so the three vaults exercise all five issuers.
    symbol: 'qMSTR',
    underlying: 'MSTR',
    unit: 'SHARE',
    pythFeedId: '0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09',
    wrappers: [
      {
        key: 'MSTRx',
        issuer: 'xStocks (Backed Finance)',
        mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
        source: 'Jupiter token search (MSTR xStock). To be confirmed against the mint metadata URI.',
        confidence: 'medium',
        live: true,
        depthNote: '<0.01% at $10k',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism: 'Same mechanism as the other xStocks: reinvested into the Scaled UI multiplier.',
      },
      {
        key: 'MSTRbp',
        issuer: 'Backpack Securities',
        mint: 'MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz',
        source: 'api.backpack.exchange /api/v1/assets MSTR.US, depositEnabled+withdrawEnabled true',
        confidence: 'medium',
        live: true,
        depthNote: '<0.01% at $10k',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism: null,
        notes: 'Mechanism unpublished, but live and deep.',
      },
      {
        key: 'MSTRon',
        issuer: 'Ondo Global Markets',
        mint: 'FSz4ouiqXpHuGPcpacZfTzbMjScoj5FfzHkiyu2ondo',
        source: 'Jupiter token search (MSTRon)',
        confidence: 'medium',
        live: false,
        depthNote: 'no Jupiter route',
        multiplierSource: 'TOKEN2022_SCALED_UI',
        dividendMechanism: null,
        notes: 'Mint exists but has no DEX route. Not registered in v1; slot reserved.',
      },
    ],
  },
];

/** Approved quote assets. The vault may hold these in addition to its own wrappers (spec §6.4). */
export const QUOTE_ASSETS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  SOL: 'So11111111111111111111111111111111111111112',
} as const;

export const ALL_WRAPPERS: WrapperEntry[] = VAULTS.flatMap((v) => v.wrappers);

/** The wrappers v1 actually registers on-chain. Dark tokens are excluded. */
export const LIVE_WRAPPERS: WrapperEntry[] = ALL_WRAPPERS.filter((w) => w.live);

/**
 * Cap passed to Jupiter's quote API as `maxAccounts`.
 *
 * Measured, not guessed. Solana caps a transaction at 64 unique account locks.
 * `swap_and_mint` spends ~18 of those on its own accounts plus the NAV triples
 * for a 3-wrapper vault, leaving ~46 for the route. Uncapped, Jupiter returns
 * 4-hop routes use 49-53 unique accounts for most of these wrappers, which
 * does NOT fit, the transaction fails to build.
 *
 * At 44 every wrapper routes in 3-4 hops and fits with room to spare, and the
 * execution cost of the constraint is negligible: the worst observed was 2bps
 * worse than the uncapped route, and several capped routes were fractionally
 * better.
 *
 * This answers `Quorum_Spec_v5.pdf` §11 item 7. The frontend MUST pass it on every quote.
 */
export const JUPITER_MAX_ACCOUNTS = 44;
