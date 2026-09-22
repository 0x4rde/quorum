'use client';

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { isCpmm, type DevnetPool } from './devnet';
import { readU64LE } from './bytes';
import { buildSwap, orient, quote } from './swap';
import { buildCpmmSwap, cpmmReserveKeys, quoteCpmm, readCpmmReserves } from './cpmm';

/**
 * One way to price and build a swap, whichever venue a holding trades at.
 *
 * Two venues exist on devnet only because one of them had to: the SPL Token
 * Swap build deployed there takes a single token program for the whole pool
 * and rejects a Token-2022 mint, so the two Scaled UI holdings live on
 * Raydium's CPMM instead. Callers should not have to care, and past this
 * module they do not: a pool is three account keys, a quote and an
 * instruction.
 *
 * Reading is split from quoting so a caller can fetch every pool's accounts
 * in one round trip.
 */

/** The accounts a quote needs, in the order `readReserves` expects them. */
export function reserveKeys(pool: DevnetPool, inputMint: PublicKey): PublicKey[] {
  if (isCpmm(pool)) return cpmmReserveKeys(pool);
  const o = orient(pool, inputMint);
  return [o.poolSource, o.poolDestination];
}

/** The reserves those accounts hold, oriented for a swap paying in `inputMint`. */
export function readReserves(
  pool: DevnetPool,
  infos: ({ data: Uint8Array } | null)[],
  inputMint: PublicKey,
): { reserveIn: bigint; reserveOut: bigint } {
  if (isCpmm(pool)) return readCpmmReserves(pool, infos, inputMint);
  const [inInfo, outInfo] = infos;
  if (!inInfo || !outInfo) throw new Error('That pool is not on chain.');
  // A token account's amount sits at offset 64 in both token programs.
  return { reserveIn: readU64LE(inInfo.data, 64), reserveOut: readU64LE(outInfo.data, 64) };
}

/** What `amountIn` buys, net of that venue's fee. */
export function quoteAt(
  pool: DevnetPool,
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint {
  return isCpmm(pool)
    ? quoteCpmm(reserveIn, reserveOut, amountIn)
    : quote(reserveIn, reserveOut, amountIn);
}

/** The swap instruction, signed by the user and by nothing else. */
export function buildSwapAt(args: {
  pool: DevnetPool;
  user: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const { pool, ...rest } = args;
  return isCpmm(pool) ? buildCpmmSwap({ pool, ...rest }) : buildSwap({ pool, ...rest });
}

/** The decimals of what comes out, for showing a quote. */
export function outputDecimals(pool: DevnetPool, inputMint: PublicKey): number {
  if (!isCpmm(pool)) return pool.decimalsA;
  return inputMint.toBase58() === pool.mint0 ? pool.decimals1 : pool.decimals0;
}
