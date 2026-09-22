/**
 * One way to price and build a swap, whichever venue a holding trades at.
 *
 * Mirrors `frontend/src/lib/pool.ts`. Two venues exist on devnet only
 * because one of them had to: the SPL Token Swap build deployed there takes
 * a single token program for the whole pool and rejects a Token-2022 mint,
 * so the two Scaled UI holdings live on Raydium's CPMM instead. Past this
 * module a caller need not care which.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  buildCpmmSwap,
  isCpmm,
  orientCpmm,
  quoteCpmm,
  type CpmmPool,
} from './cpmm.js';
import { buildSwap, orient, quote, type Pool as TokenSwapPool } from './swap.js';

export type AnyPool = (TokenSwapPool & { kind?: 'tokenSwap' }) | CpmmPool;

/** The accounts a quote needs, in the order `readReserves` expects them. */
export function reserveKeys(pool: AnyPool, inputMint: PublicKey): PublicKey[] {
  if (isCpmm(pool)) {
    return [
      new PublicKey(pool.poolId),
      new PublicKey(pool.vault0),
      new PublicKey(pool.vault1),
    ];
  }
  const o = orient(pool, inputMint);
  return [o.poolSource, o.poolDestination];
}

/**
 * The tradable reserves those accounts hold, oriented for a swap paying in
 * `inputMint`.
 *
 * A CPMM pool's vaults hold more than the curve trades on: protocol and fund
 * fees accumulate in place and are tracked in the pool state rather than
 * being swept out, so they come off here.
 */
export function readReserves(
  pool: AnyPool,
  infos: ({ data: Buffer } | null)[],
  inputMint: PublicKey,
): { reserveIn: bigint; reserveOut: bigint } {
  // A token account's amount sits at offset 64 in both token programs.
  if (!isCpmm(pool)) {
    const [inInfo, outInfo] = infos;
    if (!inInfo || !outInfo) throw new Error(`a reserve of ${pool.swapAccount} is missing`);
    return {
      reserveIn: inInfo.data.readBigUInt64LE(64),
      reserveOut: outInfo.data.readBigUInt64LE(64),
    };
  }

  const [state, v0, v1] = infos;
  if (!state || !v0 || !v1) throw new Error(`${pool.pair} is not on chain`);
  const PROTOCOL_FEE_0 = 8 + 32 * 10 + 5 + 8;
  const owed = (i: 0 | 1) =>
    state.data.readBigUInt64LE(PROTOCOL_FEE_0 + i * 8) +
    state.data.readBigUInt64LE(PROTOCOL_FEE_0 + 16 + i * 8);
  const r0 = v0.data.readBigUInt64LE(64) - owed(0);
  const r1 = v1.data.readBigUInt64LE(64) - owed(1);
  return inputMint.toBase58() === pool.mint0
    ? { reserveIn: r0, reserveOut: r1 }
    : { reserveIn: r1, reserveOut: r0 };
}

/** What `amountIn` buys, net of that venue's fee. */
export function quoteAt(
  pool: AnyPool,
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint {
  return isCpmm(pool)
    ? quoteCpmm(reserveIn, reserveOut, amountIn)
    : quote(reserveIn, reserveOut, amountIn);
}

/** The swap instruction, signed by the caller and by nobody else. */
export function buildSwapAt(args: {
  pool: AnyPool;
  user: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const { pool, ...rest } = args;
  return isCpmm(pool) ? buildCpmmSwap({ pool, ...rest }) : buildSwap({ pool, ...rest });
}

/** The two mints a pool trades, as base58. */
export function poolMints(pool: AnyPool): [string, string] {
  return isCpmm(pool) ? [pool.mint0, pool.mint1] : [pool.mintA, pool.mintB];
}

/** The decimals of a mint in this pool. */
export function decimalsOf(pool: AnyPool, mint: string): number {
  if (isCpmm(pool)) return mint === pool.mint0 ? pool.decimals0 : pool.decimals1;
  // The Token Swap records only ever stored the holding's decimals; the
  // other side is mUSDC, which has six.
  return mint === pool.mintA ? pool.decimalsA : 6;
}

/** The token program that owns a mint in this pool. */
export function programOf(pool: AnyPool, mint: string): PublicKey {
  return new PublicKey(
    isCpmm(pool)
      ? mint === pool.mint0
        ? pool.program0
        : pool.program1
      : mint === pool.mintA
        ? pool.programA
        : pool.programB,
  );
}
