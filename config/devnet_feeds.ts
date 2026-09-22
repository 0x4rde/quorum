/**
 * Which Pyth feed each vault reads on devnet, and where that differs from
 * mainnet.
 *
 * The real feed ids live in `config/wrappers.ts` and are what mainnet uses.
 * Devnet cannot always use them, for one reason: Hermes authenticates every
 * request and a feed has to be granted on the account. Measured twice on
 * 2026-09-22, on either side of a plan change:
 *
 *                            trial   free   granted
 *   Metal.XAU/USD            200     403    200
 *   Equity.US.SPY/USD        403     403    200
 *   Equity.US.MSTR/USD       403     403    200
 *   Crypto.PAXG/USD          403     403    200
 *   Crypto.XAUT/USD          403     403    200
 *   Crypto.SPYX/USD          403     403    200
 *   Crypto.MSTRX/USD         403     403    200
 *
 * Pyth granted every feed we asked for on 2026-09-22, in answer to
 * `docs/pyth_support_request.md`. There are no stand-ins any more: each
 * vault reads the feed it would read on mainnet, and the wrapper feeds the
 * depeg test wants are available too.
 *
 * The one thing still missing is a time-weighted price. `/v2/updates/twap`
 * returns 404 whatever the entitlement, and the whole of mainnet holds two
 * `TwapUpdate` accounts, both years stale. That is what `alt_oracle_program`
 * on the vault exists for.
 *
 * A stand-in changes the number a vault prices its basket at. It changes
 * nothing about the code path: the same `read_underlying_price`, the same
 * staleness and confidence guards, the same NAV arithmetic. What devnet
 * cannot demonstrate either way is the market-hours behaviour of an equity
 * feed, because a crypto feed never closes.
 *
 * Entitlements are granted per feed, not per class.
 */

export interface FeedBinding {
  /** Index token symbol. */
  vault: string;
  /** Pyth feed id, 32-byte hex with the `0x` prefix. */
  feedId: string;
  /** Human name of the feed actually being read. */
  label: string;
  /**
   * Set when this is not the production feed. The text says what mainnet
   * would read instead, so nobody mistakes a devnet reading for a real one.
   */
  standIn?: string;
}

export const DEVNET_FEEDS: FeedBinding[] = [
  {
    // No stand-in: this vault reads exactly what it would read on mainnet,
    // and Pyth maintains it on devnet.
    vault: 'qSOL',
    feedId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    label: 'Crypto.SOL/USD',
  },
  {
    vault: 'qSPY',
    feedId: '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
    label: 'Equity.US.SPY/USD',
  },
  {
    vault: 'qMSTR',
    feedId: '0xe1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09',
    label: 'Equity.US.MSTR/USD',
  },
  {
    vault: 'qGOLD',
    feedId: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
    label: 'Metal.XAU/USD',
  },
];

export const feedFor = (vault: string): FeedBinding => {
  const f = DEVNET_FEEDS.find((x) => x.vault === vault);
  if (!f) throw new Error(`No devnet feed binding for ${vault}`);
  return f;
};
