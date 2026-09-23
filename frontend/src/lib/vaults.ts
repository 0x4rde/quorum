/**
 * The vault registry, mirrored from `config/wrappers.ts` at the repo root.
 *
 * Kept as a copy rather than an import because the frontend deploys to Vercel
 * on its own and must not reach outside its directory at build time. When the
 * on-chain registry changes, both move together. `scripts/verify_wrappers.ts`
 * is the source of truth for the addresses, and every one here has been read
 * back off mainnet.
 *
 * Only `live: true` wrappers are registered on-chain. The dark ones are kept
 * so the UI can say *why* a slot is empty rather than silently showing two
 * issuers where the pitch promises three.
 */

export type MultiplierSource = 'FIXED' | 'TOKEN2022_SCALED_UI' | 'KEEPER_PUSHED';

export interface Wrapper {
  key: string;
  issuer: string;
  mint: string;
  live: boolean;
  /** Measured Jupiter price impact on a $10k buy. Why it is in or out. */
  depth: string;
  /**
   * The same measurement as a number, for comparing.
   *
   * `depth` is prose: it carries the "<" in "<0.01%" and the words in "no
   * route", which a number cannot. Comparing those strings with `>` sorts
   * them alphabetically, and "<" sorts above every digit, so "<0.01%" reads
   * as worse than "0.51%" and a basket reports its best leg as its worst.
   * `Infinity` for a wrapper with no route at all.
   */
  depthPct: number;
  multiplierSource: MultiplierSource;
  /** Pyth feed for the wrapper itself, where one exists. Enables swap_depegged. */
  wrapperFeedId: string | null;
  decimals: number;
  /** Reason the wrapper is not live. */
  darkReason?: string;
}

export interface Vault {
  symbol: string;
  underlying: string;
  unit: 'SHARE' | 'OUNCE';
  unitLabel: string;
  pythFeedId: string;
  blurb: string;
  wrappers: Wrapper[];
}

export const VAULTS: Vault[] = [
  {
    symbol: 'qSPY',
    underlying: 'SPY',
    unit: 'SHARE',
    unitLabel: 'SPY share',
    pythFeedId: '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
    blurb: 'The deepest equity pair on Solana. Backpack has provisioned SPY but not switched it on.',
    wrappers: [
      {
        key: 'SPYx', issuer: 'xStocks', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
        live: true, depth: '<0.01%', depthPct: 0.01, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 8,
        wrapperFeedId: '0x2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14',
      },
      {
        key: 'SPYon', issuer: 'Ondo', mint: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo',
        live: true, depth: '0.09%', depthPct: 0.09, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 9,
        wrapperFeedId: null,
      },
      {
        key: 'SPYbp', issuer: 'Backpack', mint: 'SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi',
        live: false, depth: 'no route', depthPct: Number.POSITIVE_INFINITY, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 6,
        wrapperFeedId: null,
        darkReason: 'Issuer has not enabled it: zero supply, transfers disabled.',
      },
    ],
  },
  {
    symbol: 'qMSTR',
    underlying: 'MSTR',
    unit: 'SHARE',
    unitLabel: 'MSTR share',
    pythFeedId: '0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09',
    blurb: 'A different issuer pair from qSPY, on purpose: three vaults, all five issuers.',
    wrappers: [
      {
        key: 'MSTRx', issuer: 'xStocks', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
        live: true, depth: '<0.01%', depthPct: 0.01, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 8,
        wrapperFeedId: '0x53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28',
      },
      {
        key: 'MSTRbp', issuer: 'Backpack', mint: 'MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz',
        live: true, depth: '<0.01%', depthPct: 0.01, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 6,
        wrapperFeedId: null,
      },
      {
        key: 'MSTRon', issuer: 'Ondo', mint: 'FSz4ouiqXpHuGPcpacZfTzbMjScoj5FfzHkiyu2ondo',
        live: false, depth: 'no route', depthPct: Number.POSITIVE_INFINITY, multiplierSource: 'TOKEN2022_SCALED_UI', decimals: 9,
        wrapperFeedId: null,
        darkReason: 'Mint exists but has no DEX route.',
      },
    ],
  },
  {
    symbol: 'qGOLD',
    underlying: 'XAU',
    unit: 'OUNCE',
    unitLabel: 'troy ounce',
    pythFeedId: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
    blurb: 'Three issuers of the same ounce. The only asset on Solana where all three are deep.',
    wrappers: [
      {
        key: 'PAXG', issuer: 'Paxos', mint: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW',
        live: true, depth: '<0.01%', depthPct: 0.01, multiplierSource: 'FIXED', decimals: 6,
        wrapperFeedId: '0x273717b49430906f4b0c230e99aa1007f83758e3199edbc887c0d06c3e332494',
      },
      {
        key: 'XAUt0', issuer: 'Tether', mint: 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P',
        live: true, depth: '0.02%', depthPct: 0.02, multiplierSource: 'FIXED', decimals: 6,
        wrapperFeedId: '0x44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67',
      },
      {
        key: 'GOLD', issuer: 'Oro', mint: 'GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A',
        live: true, depth: '0.51%', depthPct: 0.51, multiplierSource: 'FIXED', decimals: 6,
        wrapperFeedId: null,
      },
    ],
  },
];

export const bySymbol = (s: string) => VAULTS.find((v) => v.symbol.toLowerCase() === s.toLowerCase());

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';

/** Route-budget constants live in `pyth.ts`, next to the price-posting cost. */
export { JUPITER_MAX_ACCOUNTS } from './pyth';

export const PROGRAM_ID = '3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi';

/** Spec §10 / on-chain defaults, shown in the UI as live config. */
export const DEFAULTS = {
  feeMintBps: 10,
  feeRedeemBps: 10,
  marketClosedSurchargeBps: 30,
  maxWeightBps: 4000,
  softDepegBps: 200,
  hardDepegBps: 500,
  minDepegDurationSeconds: 600,
  maxAgeSeconds: 60,
  navBreakerBps: 800,
  callerRewardBps: 1000,
};
