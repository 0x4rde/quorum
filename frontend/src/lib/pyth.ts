/**
 * Pyth pull-oracle posting.
 *
 * Pyth is a *pull* oracle: prices live on Pythnet, not on Solana. A price is
 * not on Solana until somebody pays to put it there. Pyth keeps a set of
 * "sponsored" feed accounts continuously fresh, but only for the heavily-used
 * ones: SOL, BTC and USDC update every ~37 seconds, while XAU, SPY, MSTR and the
 * wrapper feeds are 8 to 45 days stale.
 *
 * So every transaction that needs a price posts that price itself, in the same
 * transaction, via `post_update_atomic` on the Pyth receiver. This is the
 * intended pattern and needs no change to the Quorum program: it just finds a
 * fresh `PriceUpdateV2` where it expected one.
 *
 * Nothing here runs a keeper to keep those feeds warm. That would be
 * cheaper per user action, but it reintroduces exactly the operator dependency
 * invariant 7 exists to remove: if the keeper dies, minting stops. Posting
 * per-transaction fails in the right direction: no price, no transaction,
 * nobody harmed.
 *
 * ## What is and is not wired up
 *
 * The addresses, derivations and account layout here are verified against
 * mainnet. What is missing is **credentials**.
 *
 * On 2026-08-26 Pyth's Core upgrade put the hosted Hermes behind an API key
 * and moved it to `pyth.dourolabs.app/hermes`. Two failure modes, and they
 * are not the same problem:
 *
 * - 401 `unauthorized`: no key at all. Fixable by signing up.
 * - 403 `Not entitled: feed <id>`: authenticated, but the key has no
 *   grant for that feed. Equity feeds are granted separately from crypto, so
 *   a key that prices BTC fine can still refuse SPY. **This one cannot be
 *   fixed in code: the grant has to be accepted on the account.
 *
 * Sign up: https://pythdata.app/signup (free trial, paid plans after).
 * Feed grants are accepted in the same terminal; data@dourolabs.xyz for
 * anything unusual.
 *
 * The three vaults need Metal.XAU, Equity.US.SPY and Equity.US.MSTR plus four
 * Crypto.* wrapper feeds, so an equity grant is required, not optional.
 *
 * The endpoint stays pluggable regardless: Hermes is open source, so
 * self-hosting against Pythnet avoids the key entirely.
 */

import { PublicKey } from '@solana/web3.js';
import { readI64LE, readU64LE } from './bytes';

/** Pyth Solana receiver. Verified on mainnet: executable, upgradeable loader. */
export const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

/** Wormhole core, which holds the guardian sets `post_update_atomic` checks against. */
export const WORMHOLE = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth');

/** Push-oracle program: sponsored feed accounts live here at shard 0. */
export const PYTH_PUSH_ORACLE = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');

/** Derived and confirmed present on mainnet. */
export const PYTH_CONFIG = new PublicKey('DaWUKXCyXsnzcvLUyeJRWou8KTn7XtadgTsdhJ6RHS7b');
export const PYTH_TREASURY_0 = new PublicKey('8hQfT7SVhkCrzUSgBq6u2wYEt1sH3xmofZ5ss3YaydZW');

/**
 * Solana allows this many unique account locks per transaction. Everything
 * about route sizing comes back to this number.
 */
export const MAX_TX_ACCOUNT_LOCKS = 64;

/**
 * Locks `mint_in_kind` spends on its own accounts: 11 named plus the NAV
 * triples for a 3-wrapper vault, less the three that overlap with the named
 * target wrapper, plus the fee payer.
 *
 * The program contains no route, so the Jupiter swap is its own top-level
 * instruction beside this one. The union of accounts is what counts against
 * the 64-lock cap, so the budget is unchanged by the split.
 */
export const QUORUM_LOCKS = 18;

/**
 * Additional unique locks for one `post_update_atomic`.
 *
 * The instruction takes 7 accounts (payer, guardian_set, config, treasury,
 * price_update_account, system_program, write_authority) but `payer` and
 * `system_program` are already in the transaction and `write_authority` is the
 * payer. So the new ones are guardian_set, config, treasury,
 * price_update_account, plus the receiver program itself.
 */
export const POST_UPDATE_LOCKS = 5;

/**
 * A second feed in the same transaction (as `swap_depegged` needs) only adds
 * its own price account, because config, treasury, guardian set and the program are
 * shared.
 */
export const POST_UPDATE_EXTRA_FEED_LOCKS = 1;

/** Locks left for the Jupiter route on a mint that posts one price. */
export const ROUTE_LOCK_BUDGET = MAX_TX_ACCOUNT_LOCKS - QUORUM_LOCKS - POST_UPDATE_LOCKS;

/**
 * Value passed to Jupiter as `maxAccounts`.
 *
 * **This is a hint, not a limit.** Measured 2026-09-20: asking for 40 returned
 * a 45-unique-account route for XAUt0, which would not have fit. 36 leaves
 * every wrapper inside budget with room to spare (worst observed total: 61 of
 * 64). Because the hint is not binding, `/api/quote` also counts the accounts
 * Jupiter actually returns and refuses anything over budget, because the hint is an
 * optimisation, the count is the guarantee.
 */
export const JUPITER_MAX_ACCOUNTS = 36;

/**
 * Shards to probe when locating a feed's sponsored account.
 *
 * Shard is not cosmetic. Measured 2026-09-20:
 *
 * | Feed | shard 0 | shard 1 |
 * |---|---|---|
 * | XAU/USD | 598h | **41h** |
 * | SPY/USD | 598h | **38h** |
 * | MSTR/USD | 882h | **38h** |
 * | PAXG, XAUT, SPYx, MSTRx | 193–1080h | no account |
 *
 * Shard 1 is actively maintained, with SOL/USD at ~11s there, and the three
 * underlyings are on it. Their 38–41h staleness is Friday's market close, not
 * neglect. Shard 0 is abandoned for these feeds.
 *
 * So the underlyings need no API at all during market hours; the wrapper
 * feeds, which exist only on the dead shard, do. Rather than hardcode that
 * split, `resolveFeedAccount` probes and takes the freshest, which
 * self-corrects if Pyth moves a feed again.
 */
export const FEED_SHARDS = [0, 1, 2] as const;

/** Sponsored feed account for a feed id at a given shard. */
export function sponsoredFeedAccount(feedIdHex: string, shard = 0): PublicKey {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(shard);
  const id = Buffer.from(feedIdHex.replace(/^0x/, ''), 'hex');
  return PublicKey.findProgramAddressSync([s, id], PYTH_PUSH_ORACLE)[0];
}

export function guardianSetAccount(index: number): PublicKey {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(index);
  return PublicKey.findProgramAddressSync([Buffer.from('GuardianSet'), b], WORMHOLE)[0];
}

export interface PriceUpdate {
  /** Base64 merkle price update, ready for `post_update_atomic`. */
  data: string;
  feedId: string;
  price: number;
  conf: number;
  publishTime: number;
}

export class HermesUnavailable extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HermesUnavailable';
  }
}

/**
 * Fetch signed price updates for `feedIds`.
 *
 * Reads the endpoint from env so a self-hosted Hermes, a provider's instance
 * or Pyth's hosted one are all drop-in. Hermes is open source, so self-hosting
 * is a real option and avoids the key entirely.
 *
 * Throws `HermesUnavailable` on 401 rather than returning empty, because a
 * caller must not be able to mistake "no price available" for "price is zero".
 */
export async function fetchPriceUpdates(feedIds: string[]): Promise<PriceUpdate[]> {
  // Pyth moved the hosted Hermes to Douro Labs in the 2026-08-26 Core upgrade
  // and put price routes behind an API key. Metadata and /live stay open, so
  // the host looks healthy at a glance even with no credentials.
  const base = process.env.PYTH_HERMES_URL ?? 'https://pyth.dourolabs.app/hermes';
  const key = process.env.PYTH_API_KEY;

  const qs = feedIds.map((i) => `ids[]=${i.replace(/^0x/, '')}`).join('&');
  const url = `${base}/v2/updates/price/latest?${qs}&encoding=base64&parsed=true`;

  const res = await fetch(url, {
    cache: 'no-store',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });

  // 401 and 403 are different problems and only one of them is ours to fix.
  if (res.status === 401) {
    throw new HermesUnavailable(
      401,
      'Hermes has no API key. Set PYTH_API_KEY (sign up at https://pythdata.app/signup) ' +
        'or point PYTH_HERMES_URL at a self-hosted instance.',
    );
  }
  if (res.status === 403) {
    const detail = await res.text().catch(() => '');
    throw new HermesUnavailable(
      403,
      'Hermes accepted the key but the account has no grant for this feed' +
        (detail ? ` (${detail.trim()})` : '') +
        '. Equity feeds are granted separately from crypto, so a key that prices BTC ' +
        'can still refuse SPY. Accept the grant in Pyth Terminal; this cannot be ' +
        'fixed in code.',
    );
  }
  if (!res.ok) throw new HermesUnavailable(res.status, `Hermes returned ${res.status}`);

  const j = (await res.json()) as {
    binary: { data: string[] };
    parsed: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }>;
  };

  return (j.parsed ?? []).map((p, i) => {
    const scale = 10 ** p.price.expo;
    return {
      data: j.binary.data[i] ?? j.binary.data[0],
      feedId: '0x' + p.id,
      price: Number(p.price.price) * scale,
      conf: Number(p.price.conf) * scale,
      publishTime: p.price.publish_time,
    };
  });
}

/**
 * Budget check for a candidate transaction.
 *
 * `routeAccounts` is the number of *unique* accounts in Jupiter's swap
 * instruction, not the length of its AccountMeta list, which double-counts.
 */
export function fitsInTransaction(routeAccounts: number, feedsPosted = 1): {
  fits: boolean; total: number; limit: number; breakdown: Record<string, number>;
} {
  const post = feedsPosted > 0
    ? POST_UPDATE_LOCKS + (feedsPosted - 1) * POST_UPDATE_EXTRA_FEED_LOCKS
    : 0;
  const total = QUORUM_LOCKS + post + routeAccounts;
  return {
    fits: total <= MAX_TX_ACCOUNT_LOCKS,
    total,
    limit: MAX_TX_ACCOUNT_LOCKS,
    breakdown: { quorum: QUORUM_LOCKS, priceUpdates: post, route: routeAccounts },
  };
}


/** One feed's best available on-chain account. */
export interface ResolvedFeed {
  feedId: string;
  account: string;
  shard: number;
  price: number;
  conf: number;
  publishTime: number;
  ageSeconds: number;
}

const MSG = 8 + 32 + 1;
const OFF = { feedId: MSG, price: MSG + 32, conf: MSG + 40, expo: MSG + 48, publish: MSG + 52 };

/**
 * Find the freshest sponsored account for each feed, across shards.
 *
 * Returns only accounts whose stored feed id matches what was asked for, so a
 * PDA collision or a repurposed account cannot be mistaken for a price.
 */
export async function resolveFeedAccounts(
  rpcUrl: string,
  feedIds: string[],
): Promise<Map<string, ResolvedFeed>> {
  const probes = feedIds.flatMap((feedId) =>
    FEED_SHARDS.map((shard) => ({
      feedId, shard, account: sponsoredFeedAccount(feedId, shard).toBase58(),
    })),
  );

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
      params: [probes.map((p) => p.account), { encoding: 'base64' }],
    }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);

  const j = await res.json();
  const now = Math.floor(Date.now() / 1000);
  const best = new Map<string, ResolvedFeed>();

  (j.result?.value ?? []).forEach((acc: { data: [string, string] } | null, i: number) => {
    if (!acc) return;
    const d = Buffer.from(acc.data[0], 'base64');
    if (d.length < OFF.publish + 8) return;

    const onChain = '0x' + d.subarray(OFF.feedId, OFF.feedId + 32).toString('hex');
    const { feedId, shard, account } = probes[i];
    if (onChain !== feedId) return;

    const scale = 10 ** d.readInt32LE(OFF.expo);
    const publishTime = Number(readI64LE(d, OFF.publish));
    const found: ResolvedFeed = {
      feedId, account, shard,
      price: Number(readI64LE(d, OFF.price)) * scale,
      conf: Number(readU64LE(d, OFF.conf)) * scale,
      publishTime,
      ageSeconds: now - publishTime,
    };
    const prev = best.get(feedId);
    if (!prev || found.ageSeconds < prev.ageSeconds) best.set(feedId, found);
  });

  return best;
}
