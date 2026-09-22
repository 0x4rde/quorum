import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { DEVNET, isCpmm, type DevnetVault } from '@/lib/devnet';
import type { LiveLeg, LiveVault } from '@/lib/live';

/**
 * Live state of the devnet deployment, read straight off the chain.
 *
 * Everything here comes from account data, not from the repository: the
 * vault's status byte, the balance in each PDA-owned token account, the index
 * supply, the Scaled UI multiplier on each Token-2022 mint, and the price and
 * publish time in the Pyth account the vault reads. The addresses are the
 * only thing taken from `devnet.json`, and each one is printed so a reader
 * can check any figure against an explorer.
 *
 * Weights are computed the way the program computes them, from units rather
 * than raw balances: a wrapper's units are `balance * units_per_token *
 * multiplier`, and reading the raw balance instead is the silent accounting
 * bug invariant 5 exists to prevent. Every devnet mock is one unit per token,
 * so the multiplier is the whole of the difference, and the response reports
 * both numbers so the page can show the gap rather than assert it.
 *
 * The RPC URL stays server-side, as with the other routes. Set
 * SOLANA_DEVNET_RPC_URL in Vercel; the public endpoint is heavily
 * rate-limited and will intermittently 429.
 */
export const revalidate = 0;

const RPC = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const HERMES = (process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network').replace(/\/$/, '');

/** Pyth's push oracle. Sponsored accounts are PDAs of `[shard, feed_id]`. */
const PUSH_ORACLE = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');

/**
 * Is this price account one Pyth maintains, rather than one we posted?
 *
 * It matters because the two age differently. Pyth refreshes its own devnet
 * accounts every minute or two with no operator and no API key, so an age of
 * a few seconds there means the feed is genuinely live. An account we posted
 * is a snapshot that only moves when somebody runs a script, and it stops
 * moving entirely if we lose the Hermes access needed to fetch a signed
 * update. Same number on screen, very different claim.
 */
function isSponsored(priceAccount: string | null, feedId: string): boolean {
  if (!priceAccount) return false;
  const feed = Buffer.from(feedId.replace(/^0x/, ''), 'hex');
  for (const shard of [0, 1]) {
    const s = Buffer.alloc(2);
    s.writeUInt16LE(shard);
    const [pda] = PublicKey.findProgramAddressSync([s, feed], PUSH_ORACLE);
    if (pda.toBase58() === priceAccount) return true;
  }
  return false;
}

/**
 * Can anyone post a newer price for these vaults right now?
 *
 * Quorum reads a pull oracle, so a price is only as current as the last
 * person to post one. Posting needs a signed update from Hermes, and Hermes
 * authenticates every request, so when the account has no grant the price on
 * chain is frozen at whatever was last written. A page that showed the age
 * without saying that would read as a feed that happens to be a bit behind,
 * rather than one that will never move again.
 *
 * Tested rather than assumed, with one feed, so the answer corrects itself
 * the moment access is restored.
 */
async function oracleRefreshable(): Promise<{ refreshable: boolean; reason: string | null }> {
  const key = process.env.PYTH_API_KEY;
  const feed = '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2';
  try {
    const r = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feed}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) return { refreshable: true, reason: null };
    return {
      refreshable: false,
      reason:
        r.status === 401 || r.status === 403
          ? 'the Pyth account has no feed grants, so no newer signed price can be fetched'
          : `Hermes returned ${r.status}`,
    };
  } catch {
    return { refreshable: false, reason: 'Hermes is unreachable' };
  }
}

/** `VaultStatus`, in declaration order. */
const STATUS = ['ACTIVE', 'MARKET_CLOSED', 'PAUSED', 'HALTED'];

/** `Vault::MAX_WRAPPERS`, which fixes the size of the registry array. */
const MAX_WRAPPERS = 8;

/**
 * Decode the Vault account's parameters and NAV state.
 *
 * Borsh is packed and ordered, so this walks the struct in declaration order
 * rather than indexing by hand. The point of reading them rather than
 * restating the compiled defaults is that a vault's parameters can be changed
 * after deployment by `update_vault_config`, and a page that printed the
 * defaults would keep saying 60 seconds long after someone set an hour.
 */
function decodeVault(d: Buffer) {
  // bump(1) symbol(12) unit(1) status(1) authority(32) guardian(32)
  // index_mint(32) index_mint_bump(1) underlying_feed_id(32)
  let o = 8 + 1 + 12 + 1 + 1 + 32 + 32 + 32 + 1 + 32;
  const u16 = () => { const v = d.readUInt16LE(o); o += 2; return v; };
  const u64 = () => { const v = Number(d.readBigUInt64LE(o)); o += 8; return v; };
  const i64 = () => { const v = Number(d.readBigInt64LE(o)); o += 8; return v; };
  const u128 = () => {
    const lo = d.readBigUInt64LE(o);
    const hi = d.readBigUInt64LE(o + 8);
    o += 16;
    return (hi << 64n) | lo;
  };

  const config = {
    maxAgeSeconds: u64(),
    maxConfBps: u16(),
    feeMintBps: u16(),
    feeRedeemBps: u16(),
    marketClosedSurchargeBps: u16(),
    navBreakerBps: u16(),
    navBreakerWindowSeconds: i64(),
    softDepegBps: u16(),
    hardDepegBps: u16(),
    minDepegDurationSeconds: i64(),
    twapWindowSeconds: u64(),
    maxSwapBps: u16(),
    swapCooldownSeconds: i64(),
    callerRewardBps: u16(),
    rebalanceDriftBps: u16(),
    maxLossBps: u16(),
    minGainBps: u16(),
  };

  const wrapperCount = d.readUInt8(o);
  o += 1 + 32 * MAX_WRAPPERS;

  u128(); // nav_anchor_per_token
  i64(); // nav_anchor_ts
  const lastSwapTs = i64();
  const navPerToken = u128();
  const navTotal = u128();
  u64(); // nav_updated_slot
  const navUpdatedTs = i64();

  return {
    config,
    wrapperCount,
    nav: {
      // NAV_SCALE is 1e9, and these are USD.
      perToken: Number(navPerToken) / 1e9,
      total: Number(navTotal) / 1e9,
      updatedTs: navUpdatedTs,
      lastPermissionlessSwapTs: lastSwapTs,
    },
  };
}

/** Scaled UI Amount config sits in the Token-2022 TLV after byte 166. */
function readScaledUiMultiplier(data: Buffer): number | null {
  if (data.length <= 166) return null;
  let o = 166;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    const body = o + 4;
    if (body + len > data.length) return null;
    if (type === 25) return data.readDoubleLE(body + 32); // ScaledUiAmountConfig
    o = body + len;
  }
  return null;
}

async function getAccounts(addresses: string[]): Promise<(Buffer | null)[]> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [addresses, { encoding: 'base64' }],
    }),
  });
  if (!r.ok) throw new Error(`rpc ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'rpc error');
  return (j.result?.value ?? []).map((a: { data: [string, string] } | null) =>
    a ? Buffer.from(a.data[0], 'base64') : null,
  );
}

/**
 * Read a price account's averaged price, which is what the depeg check reads.
 *
 * Pyth ships an exponentially weighted average in the same message as spot.
 * Showing the average rather than the last tick means the premium on screen
 * is the number the on-chain guard is actually comparing, not a different
 * one that happens to be close.
 */
function emaOf(data: Buffer | null): number | null {
  if (!data) return null;
  // disc(8) write_authority(32) verification(1) feed_id(32) price(8) conf(8)
  // exponent(4) publish_time(8) prev_publish_time(8) ema_price(8)
  const o = 8 + 32 + 1 + 32;
  const exponent = data.readInt32LE(o + 16);
  const ema = Number(data.readBigInt64LE(o + 36));
  if (ema <= 0) return null;
  return ema * 10 ** exponent;
}

/**
 * The market price of each holding, from the pool it trades in.
 *
 * This is the one thing DEX prices are for. NAV never reads them: a vault
 * holding a claim on an ounce of gold is worth an ounce of gold whatever a
 * pool says. A pool price is only evidence about whether one issuer's token
 * has come loose from the asset behind it, which is a different question and
 * the only one it is allowed to answer.
 *
 * Every pool pairs the holding against mUSDC, so the price in dollars is
 * the ratio of the two reserves adjusted for decimals. Which reserve is
 * which is decided by the mint, not by position: the Token-2022 holdings
 * trade on Raydium's CPMM, which orders its two sides by pubkey and would
 * put the dollar first as often as not.
 *
 * The number this produces is dollars per *raw* token, which for a Scaled
 * UI holding already carries the multiplier. That is the right convention
 * here, because the fair value it is compared against is built the same way.
 */
async function poolPrices(v: DevnetVault): Promise<Map<string, number>> {
  const pooled = v.wrappers
    .map((w) => ({ w, pool: DEVNET.pools[`${w.key}-mUSDC`] }))
    .filter((x) => x.pool);
  if (pooled.length === 0) return new Map();

  // Which two accounts hold the reserves, and whether the holding is the
  // first of them.
  const sides = pooled.map((x) => {
    const pool = x.pool!;
    if (isCpmm(pool)) {
      const holdingFirst = pool.mint0 === x.w.mint;
      return {
        keys: [pool.vault0, pool.vault1],
        holdingFirst,
      };
    }
    return { keys: [pool.tokenA, pool.tokenB], holdingFirst: pool.mintA === x.w.mint };
  });

  const data = await getAccounts(sides.flatMap((s) => s.keys));

  const out = new Map<string, number>();
  pooled.forEach((x, i) => {
    const first = data[i * 2];
    const second = data[i * 2 + 1];
    if (!first || !second) return;
    const { holdingFirst } = sides[i];
    const holding = holdingFirst ? first : second;
    const dollars = holdingFirst ? second : first;
    const baseAmount = Number(holding.readBigUInt64LE(64)) / 10 ** x.w.decimals;
    const quoteAmount = Number(dollars.readBigUInt64LE(64)) / 1e6;
    if (baseAmount > 0) out.set(x.w.key, quoteAmount / baseAmount);
  });
  return out;
}

async function readVault(v: DevnetVault, now: number): Promise<LiveVault> {
  const addresses = [
    v.vault,
    v.indexMint,
    ...v.wrappers.map((w) => w.tokenAccount),
    ...v.wrappers.map((w) => w.mint),
    ...(v.priceAccount ? [v.priceAccount] : []),
  ];
  const data = await getAccounts(addresses);

  const vaultData = data[0];
  const indexData = data[1];
  const n = v.wrappers.length;
  const tokenData = data.slice(2, 2 + n);
  const mintData = data.slice(2 + n, 2 + 2 * n);
  const priceData = v.priceAccount ? data[2 + 2 * n] : null;

  // Vault layout: disc(8) bump(1) symbol(12) unit(1) status(1).
  const status = vaultData ? (STATUS[vaultData[22]] ?? `unknown(${vaultData[22]})`) : 'MISSING';
  const decoded = vaultData ? decodeVault(vaultData) : null;
  const supply = indexData ? Number(indexData.readBigUInt64LE(36)) / 1e9 : 0;

  const legs: LiveLeg[] = v.wrappers.map((w, i) => {
    // SPL token account: mint(32) owner(32) amount(8) at offset 64.
    const balanceRaw = tokenData[i] ? Number(tokenData[i]!.readBigUInt64LE(64)) : 0;
    const balance = balanceRaw / 10 ** w.decimals;
    const multiplier = mintData[i] ? readScaledUiMultiplier(mintData[i]!) : null;
    return {
      key: w.key,
      standsFor: w.standsFor,
      mainnetKey: w.mainnetKey,
      mint: w.mint,
      tokenAccount: w.tokenAccount,
      multiplierSource: w.multiplierSource,
      balance,
      multiplier,
      units: balance * (multiplier ?? 1),
      weightBps: 0,
      targetWeightBps: w.targetWeightBps,
      marketPrice: null,
      premiumBps: null,
      priceSource: null,
    };
  });

  const totalUnits = legs.reduce((a, l) => a + l.units, 0);
  for (const l of legs) {
    l.weightBps = totalUnits > 0 ? Math.round((10_000 * l.units) / totalUnits) : 0;
  }

  let price: number | null = null;
  let priceAgeSeconds: number | null = null;
  if (priceData) {
    // PriceUpdateV2: disc(8) write_authority(32) verification(1) feed_id(32)
    //                price(i64) conf(u64) exponent(i32) publish_time(i64)
    const o = 8 + 32 + 1 + 32;
    price = Number(priceData.readBigInt64LE(o)) * 10 ** priceData.readInt32LE(o + 16);
    priceAgeSeconds = now - Number(priceData.readBigInt64LE(o + 20));
  }

  // Premium: what the market pays for one token against what one token
  // entitles the vault to.
  //
  // Pyth's own feed for the holding is preferred where the issuer publishes
  // one, because that is the number the on-chain check reads, and both sides
  // are then the same kind of average. A pool price is the fallback: real,
  // but ours, and thin. Some holdings have neither and show nothing rather
  // than a guess.
  const pooled = await poolPrices(v);
  const withFeeds = v.wrappers.filter((w) => w.wrapperPriceAccount);
  const feedData = withFeeds.length
    ? await getAccounts(withFeeds.map((w) => w.wrapperPriceAccount!))
    : [];
  const fromPyth = new Map<string, number>();
  withFeeds.forEach((w, i) => {
    const ema = emaOf(feedData[i]);
    if (ema != null) fromPyth.set(w.key, ema);
  });

  const underlyingEma = emaOf(priceData) ?? price;
  if (underlyingEma != null) {
    for (const l of legs) {
      const perToken = l.balance > 0 ? l.units / l.balance : null;
      const quoted = fromPyth.get(l.key) ?? pooled.get(l.key);
      if (perToken == null || quoted == null) continue;
      const fair = underlyingEma * perToken;
      if (fair <= 0) continue;
      l.marketPrice = quoted;
      l.premiumBps = Math.round((quoted / fair - 1) * 10_000);
      l.priceSource = fromPyth.has(l.key) ? 'pyth' : 'pool';
    }
  }

  const anyScaled = legs.some((l) => l.multiplier !== null && l.multiplier !== 1);
  const rawUnits = legs.reduce((a, l) => a + l.balance, 0);

  return {
    symbol: v.symbol,
    vault: v.vault,
    indexMint: v.indexMint,
    status,
    supply,
    feedLabel: v.feedLabel,
    standIn: v.standIn,
    priceAccount: v.priceAccount,
    price,
    priceAgeSeconds,
    maxWeightBps: v.maxWeightBps,
    sponsored: isSponsored(v.priceAccount, v.feedId),
    config: decoded?.config ?? null,
    nav: decoded?.nav ?? null,
    legs,
    // Scaled in proportion, because supply tracks units and the two differ
    // only by the multiplier. Exact enough to show the size of the gap.
    supplyIfRawRead: anyScaled && totalUnits > 0 ? (supply * rawUnits) / totalUnits : null,
  };
}

export async function GET() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const vaults = await Promise.all(DEVNET.vaults.map((v) => readVault(v, now)));

    // Only ask Hermes when the answer could matter. Every sponsored feed is
    // maintained by Pyth whatever our own access looks like, so probing an
    // endpoint nothing depends on would add a round trip to every page load
    // to answer a question nobody asked.
    const oracle = vaults.every((v) => v.sponsored)
      ? { refreshable: true, reason: null }
      : await oracleRefreshable();
    return NextResponse.json({
      cluster: DEVNET.cluster,
      programId: DEVNET.programId,
      authority: DEVNET.authority,
      deployedAt: DEVNET.deployedAt,
      vaults,
      oracle,
      fetchedAt: now,
    });
  } catch (e) {
    // The public devnet endpoint rate-limits hard. Say so rather than
    // rendering an empty deployment, which reads as "it is not there".
    return NextResponse.json(
      { error: (e as Error).message, vaults: [], programId: DEVNET.programId },
      { status: 502 },
    );
  }
}
