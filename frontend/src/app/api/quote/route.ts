import { NextResponse } from 'next/server';
import { JUPITER_MAX_ACCOUNTS, fitsInTransaction } from '@/lib/pyth';

/**
 * Jupiter quote proxy, with the transaction budget enforced rather than hoped.
 *
 * Two things happen here that a client must not be trusted to do:
 *
 * **1. `maxAccounts` is forced server-side.** Uncapped, Jupiter returns 4-hop
 * routes using 49–53 unique accounts, which cannot fit alongside the mint
 * instruction and a price update.
 *
 * **2. The returned route is counted.** `maxAccounts` turned out to be a *hint*,
 * not a limit: asking for 40 came back with a 45-account route for XAUt0. So
 * asking politely is an optimisation; counting what actually arrived is the
 * guarantee. A route over budget is reported as such instead of being handed
 * to a user whose transaction would fail to build.
 *
 * Counting costs a second call to `swap-instructions`, which roughly doubles
 * quote latency. Worth it: the alternative is an intermittent "transaction too
 * large" that is close to undiagnosable from the UI.
 */
export const revalidate = 0;

const JUP = 'https://lite-api.jup.ag/swap/v1';
/** Any valid pubkey works for counting; nothing is signed or sent. */
const PROBE_USER = '11111111111111111111111111111112';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const inputMint = u.searchParams.get('inputMint');
  const outputMint = u.searchParams.get('outputMint');
  const amount = u.searchParams.get('amount');
  const slippageBps = u.searchParams.get('slippageBps') ?? '100';
  const feedsPosted = Number(u.searchParams.get('feedsPosted') ?? '1');

  if (!inputMint || !outputMint || !amount) {
    return NextResponse.json({ error: 'inputMint, outputMint and amount are required' }, { status: 400 });
  }
  if (!/^\d+$/.test(amount)) {
    return NextResponse.json({ error: 'amount must be an integer in base units' }, { status: 400 });
  }

  try {
    const qs = new URLSearchParams({
      inputMint, outputMint, amount, slippageBps,
      maxAccounts: String(JUPITER_MAX_ACCOUNTS),
    });
    const qr = await fetch(`${JUP}/quote?${qs}`, { cache: 'no-store' });
    if (!qr.ok) {
      return NextResponse.json({ error: 'no route for that size' }, { status: 200 });
    }
    const q = await qr.json();

    // Count the accounts the route actually uses.
    let routeAccounts: number | null = null;
    try {
      const ir = await fetch(`${JUP}/swap-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          quoteResponse: q, userPublicKey: PROBE_USER, wrapAndUnwrapSol: true,
        }),
      });
      if (ir.ok) {
        const si = await ir.json();
        if (si?.swapInstruction?.accounts) {
          routeAccounts = new Set(
            si.swapInstruction.accounts.map((a: { pubkey: string }) => a.pubkey),
          ).size;
        }
      }
    } catch {
      // Budget unknown rather than wrong, so it is reported as null below.
    }

    const budget = routeAccounts === null ? null : fitsInTransaction(routeAccounts, feedsPosted);

    return NextResponse.json({
      outAmount: q.outAmount,
      inAmount: q.inAmount,
      priceImpactPct: Number(q.priceImpactPct ?? 0),
      hops: (q.routePlan ?? []).length,
      route: (q.routePlan ?? [])
        .map((p: { swapInfo: { label: string } }) => p.swapInfo?.label)
        .filter(Boolean),
      slippageBps: Number(slippageBps),
      routeAccounts,
      budget,
      /** False only when we counted and it did not fit. Null budget is not a failure. */
      usable: budget === null ? true : budget.fits,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
