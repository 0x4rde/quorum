import { NextResponse } from 'next/server';
import { VAULTS } from '@/lib/vaults';
import { HermesUnavailable, fetchPriceUpdates, resolveFeedAccounts } from '@/lib/pyth';

/**
 * Prices, from two sources, reported separately because they answer different
 * questions.
 *
 * - `hermes`: what a transaction submitted right now would post and
 *   therefore price against. This is the number a user is about to trade on.
 * - `chain`: what is in the sponsored `PriceUpdateV2` account today, i.e.
 *   what the program would read if nobody posted. For these feeds it is weeks
 *   stale (Q12), which is exactly why transactions must post their own.
 *
 * Collapsing these into one number would be a lie in one direction or the
 * other: show only Hermes and the UI implies the chain is fresh; show only the
 * chain and the UI implies minting is impossible when it is not.
 *
 * Hermes entitlements are **per feed, not per class**. A key can hold
 * Metal.XAU and still 403 on Equity.US.SPY and on Crypto.PAXG/USD. So each
 * feed is attempted independently and a 403 on one does not blank the others,
 * it is reported against that feed as `notEntitled`.
 */
export const revalidate = 0;

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';


interface Quote {
  label: string;
  hermes: { price: number; conf: number; confBps: number; publishTime: number; ageSeconds: number } | null;
  chain: { price: number; publishTime: number; ageSeconds: number; account: string; shard: number } | null;
  notEntitled: boolean;
  /** The price a transaction would price against, if one is available. */
  usable: number | null;
  usableAgeSeconds: number | null;
}

export async function GET() {
  const wanted: { feedId: string; label: string }[] = [];
  for (const v of VAULTS) {
    wanted.push({ feedId: v.pythFeedId, label: `${v.underlying}/USD` });
    for (const w of v.wrappers) {
      if (w.wrapperFeedId) wanted.push({ feedId: w.wrapperFeedId, label: `${w.key}/USD` });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, Quote> = {};
  for (const w of wanted) {
    out[w.feedId] = {
      label: w.label, hermes: null, chain: null,
      notEntitled: false, usable: null, usableAgeSeconds: null,
    };
  }

  // --- Hermes, one feed at a time so an un-entitled feed cannot blank the rest ---
  let hermesConfigured = Boolean(process.env.PYTH_API_KEY);
  await Promise.all(
    wanted.map(async (w) => {
      if (!hermesConfigured) return;
      try {
        const [u] = await fetchPriceUpdates([w.feedId]);
        if (u) {
          out[w.feedId].hermes = {
            price: u.price, conf: u.conf,
            confBps: u.price > 0 ? (u.conf / u.price) * 10_000 : 0,
            publishTime: u.publishTime,
            ageSeconds: now - u.publishTime,
          };
        }
      } catch (e) {
        if (e instanceof HermesUnavailable) {
          if (e.status === 403) out[w.feedId].notEntitled = true;
          else hermesConfigured = false; // 401: no key, stop trying
        }
      }
    }),
  );

  // --- On-chain, always, because it is what the program reads without a post ---
  //
  // Probes shards rather than assuming one: the three underlyings live on the
  // maintained shard 1 while the wrapper feeds only exist on the abandoned
  // shard 0, and hardcoding either would be wrong for half the registry.
  try {
    const resolved = await resolveFeedAccounts(RPC, wanted.map((w) => w.feedId));
    for (const w of wanted) {
      const r = resolved.get(w.feedId);
      if (!r) continue;
      out[w.feedId].chain = {
        price: r.price, publishTime: r.publishTime,
        ageSeconds: r.ageSeconds, account: r.account, shard: r.shard,
      };
    }
  } catch {
    // On-chain unavailable; Hermes values still stand.
  }

  // A transaction posts the Hermes price, so that is the usable one when the
  // have it, falling back to whatever is already on-chain.
  //
  // Except when the key is not entitled. Then there is no way to post a fresh
  // price at all, and falling back to a weeks-old account would render a
  // number the UI would go on to label "market closed", attributing a
  // billing problem to the market. `usable: null` instead, so the page can say
  // what is actually wrong.
  for (const q of Object.values(out)) {
    if (q.notEntitled) { q.usable = null; q.usableAgeSeconds = null; continue; }
    const src = q.hermes ?? q.chain;
    q.usable = src?.price ?? null;
    q.usableAgeSeconds = src?.ageSeconds ?? null;
  }

  return NextResponse.json({
    prices: out,
    fetchedAt: now,
    hermesConfigured,
    /** Feeds the key cannot price. These block mint on their vault. */
    notEntitled: Object.entries(out).filter(([, q]) => q.notEntitled).map(([, q]) => q.label),
  });
}
