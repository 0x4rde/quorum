/**
 * Trade each pool back into line with the vault that holds it.
 *
 *   npx tsx scripts/devnet_reprice_pools.ts            # plan only
 *   npx tsx scripts/devnet_reprice_pools.ts --send
 *
 * A pool priced differently from the vault it feeds is a standing
 * arbitrage. Buy the holding cheap at the pool, deposit it at the vault's
 * valuation, and the difference is free index tokens paid for by everyone
 * else. The two have to agree, and when a vault's feed changes the pools
 * built against the old one are suddenly wrong: pointing qSPY at the real
 * SPY feed moved its holding from $117 to $774, leaving a pool selling it
 * for a sixth of what the vault would credit.
 *
 * Correcting it by trading rather than by rebuilding the pool is the honest
 * version. It is exactly what an arbitrageur would do, it leaves no
 * abandoned mispriced pool behind for someone to find later, and the
 * constant-product maths that sets the new reserves is the same maths that
 * priced the trade.
 *
 * For reserves `x` of the holding and `y` of the dollar, price is `y/x` and
 * the product `k = xy` is fixed by the curve. Wanting price `p` means
 * `x = sqrt(k/p)`, and the trade is the difference from where `x` is now.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getScaledUiAmountConfig,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { POOL_PAIRS, USDC_DECIMALS } from '../config/devnet_pools.js';
import { DEVNET_FEEDS } from '../config/devnet_feeds.js';
import { MULTIPLIER } from './lib/codec.js';
import {
  buildSwapAt,
  decimalsOf,
  poolMints,
  programOf,
  quoteAt,
  readReserves,
  reserveKeys,
  type AnyPool,
} from './lib/pool.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

/** Leave a pool alone unless it is this far out. */
const TOLERANCE_BPS = 100;

const WSOL = 'So11111111111111111111111111111111111111112';

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner('Quorum: trade the pools back in line with their vaults');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();
  const usdc = new PublicKey(state.mints.mUSDC);

  // What each vault says a holding is worth, from the price it actually reads.
  const priced = new Map<string, number>();
  for (const v of MOCK_VAULTS) {
    const account = state.priceUpdates[v.symbol];
    if (!account) continue;
    const info = await conn.getAccountInfo(new PublicKey(account));
    if (!info) continue;
    const o = 8 + 32 + 1 + 32;
    const underlying =
      Number(info.data.readBigInt64LE(o)) * 10 ** info.data.readInt32LE(o + 16);
    const label = DEVNET_FEEDS.find((f) => f.vault === v.symbol)?.label ?? '?';
    for (const w of v.wrappers) {
      // One token is worth `units_per_token` of the underlying, and for a
      // Scaled UI mint the live multiplier rides on top of that.
      //
      // Live, off the mint, not `initialMultiplier` off the config:
      // `devnet_arm_depeg.ts` rewrites the on-chain multiplier to Pyth's
      // published redemption rate, so the config's opening value is stale by
      // design. Trusting it priced mSPYx 72bps away from what the vault
      // credits, which is exactly the standing arbitrage this script exists
      // to close.
      let multiplier = 1;
      if (w.multiplierSource === MULTIPLIER.Token2022ScaledUi) {
        const mintInfo = await getMint(
          conn,
          new PublicKey(state.mints[w.key]),
          'confirmed',
          TOKEN_2022_PROGRAM_ID,
        );
        multiplier = Number(getScaledUiAmountConfig(mintInfo)?.multiplier ?? 1);
      }
      const perToken = (Number(w.unitsPerToken) / 1e9) * multiplier;
      priced.set(w.key, underlying * perToken);
    }
    console.log(`  ${v.symbol.padEnd(6)} reads ${label} at $${underlying.toFixed(2)}`);
  }
  console.log();

  const trades: {
    key: string;
    pool: AnyPool;
    inputMint: PublicKey;
    amountIn: bigint;
    minOut: bigint;
    from: number;
    to: number;
  }[] = [];

  // Every pool in the deployment record, not just the ones `POOL_PAIRS`
  // opens: the Token-2022 holdings trade on Raydium's CPMM and were never in
  // that list. A pool this script skipped would be a pool free to drift away
  // from the vault it feeds, which is the one thing it exists to prevent.
  const keys = Object.keys(state.pools ?? {});

  for (const key of keys) {
    const pool = state.pools![key] as unknown as AnyPool;
    const base = key.replace(/-mUSDC$/, '');
    const fair = priced.get(base);
    if (!fair || fair <= 0) {
      console.log(`  ${key.padEnd(18)} no vault price, leaving alone`);
      continue;
    }

    const [mint0, mint1] = poolMints(pool);
    const baseMint = state.mints[base] ?? (base === 'wSOL' ? WSOL : undefined);
    if (!baseMint || (baseMint !== mint0 && baseMint !== mint1)) {
      console.log(`  ${key.padEnd(18)} cannot tell which side is the holding, leaving alone`);
      continue;
    }
    const decimalsA = decimalsOf(pool, baseMint);

    // Reserves read as if buying the holding with dollars, so `reserveIn` is
    // the dollar side and `reserveOut` the holding.
    const infos = await conn.getMultipleAccountsInfo(reserveKeys(pool, usdc));
    let reserves;
    try {
      reserves = readReserves(pool, infos, usdc);
    } catch {
      console.log(`  ${key.padEnd(18)} reserves unreadable, leaving alone`);
      continue;
    }
    const x = Number(reserves.reserveOut) / 10 ** decimalsA;
    const y = Number(reserves.reserveIn) / 10 ** USDC_DECIMALS;
    if (x <= 0 || y <= 0) continue;

    const current = y / x;
    const offBps = Math.round((current / fair - 1) * 10_000);
    if (Math.abs(offBps) <= TOLERANCE_BPS) {
      console.log(
        `  ${key.padEnd(18)} $${current.toFixed(2)} vs $${fair.toFixed(2)}, ` +
          `${offBps >= 0 ? '+' : ''}${offBps}bps, in line`,
      );
      continue;
    }

    // Where the curve puts the reserves at the price we want.
    const k = x * y;
    const targetX = Math.sqrt(k / fair);

    let inputMint: PublicKey;
    let amountIn: bigint;
    if (targetX < x) {
      // The pool is cheap: buy the holding until it is not.
      const targetY = k / targetX;
      amountIn = BigInt(Math.floor((targetY - y) * 10 ** USDC_DECIMALS));
      inputMint = usdc;
    } else {
      // The pool is dear: sell into it.
      amountIn = BigInt(Math.floor((targetX - x) * 10 ** decimalsA));
      inputMint = new PublicKey(baseMint);
    }
    if (amountIn <= 0n) continue;

    const reserveIn = inputMint.equals(usdc) ? reserves.reserveIn : reserves.reserveOut;
    const reserveOut = inputMint.equals(usdc) ? reserves.reserveOut : reserves.reserveIn;
    const out = quoteAt(pool, reserveIn, reserveOut, amountIn);

    console.log(
      `  ${key.padEnd(18)} $${current.toFixed(2)} -> $${fair.toFixed(2)} ` +
        `(${offBps >= 0 ? '+' : ''}${offBps}bps): ` +
        `${inputMint.equals(usdc) ? 'buy with' : 'sell'} ` +
        `${(Number(amountIn) / 10 ** (inputMint.equals(usdc) ? USDC_DECIMALS : decimalsA)).toFixed(4)}`,
    );
    trades.push({
      key,
      pool,
      inputMint,
      amountIn,
      minOut: (out * 9_000n) / 10_000n,
      from: current,
      to: fair,
    });
  }

  console.log();
  if (!WILL_SPEND) {
    console.log(`Dry run, ${trades.length} trade(s). Re-run with --send.\n`);
    return;
  }

  for (const t of trades) {
    // Only selling wrapped SOL would need wrapping first. Buying it with
    // dollars is an ordinary swap into an account created here.
    const [m0, m1] = poolMints(t.pool);
    const holdingMint = m0 === usdc.toBase58() ? m1 : m0;
    if (holdingMint === WSOL && !t.inputMint.equals(usdc)) {
      console.log(`  ${t.key.padEnd(18)} skipped: selling SOL needs wrapping, not wired up`);
      continue;
    }
    const outMint = t.inputMint.equals(usdc) ? new PublicKey(holdingMint) : usdc;
    const outProgram = t.inputMint.equals(usdc)
      ? programOf(t.pool, holdingMint)
      : TOKEN_PROGRAM_ID;
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        kp.publicKey,
        getAssociatedTokenAddressSync(outMint, kp.publicKey, false, outProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
        kp.publicKey,
        outMint,
        outProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      buildSwapAt({
        pool: t.pool,
        user: kp.publicKey,
        inputMint: t.inputMint,
        amountIn: t.amountIn,
        minimumAmountOut: t.minOut,
      }),
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      console.log(`  ${t.key.padEnd(18)} ${sig.slice(0, 16)}...`);
    } catch (e) {
      console.log(`  ${t.key.padEnd(18)} FAILED: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
