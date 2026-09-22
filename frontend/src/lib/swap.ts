'use client';

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM, ata } from './program';
import type { TokenSwapPool } from './devnet';
import { concatBytes, u64le } from './bytes';

/**
 * Swapping at the devnet pools, from the browser.
 *
 * Mirrors `scripts/lib/swap.ts`, which the verification script uses;
 * `tests/frontend_parity.test.ts` compares the bytes so the two cannot
 * drift. The account list is the older ten-account shape, which is what the
 * program deployed on devnet expects; the published SDK emits a newer
 * fourteen-account one that it rejects with error 0x18.
 */
export const SWAP_PROGRAM = new PublicKey('SwapsVeCiPHMUAtzQWZw7RjsKjgCjhwU55QGu4U1Szw');

/** The reserves of a pool, oriented so `source` matches the input mint. */
export function orient(pool: TokenSwapPool, inputMint: PublicKey) {
  const aIsInput = pool.mintA === inputMint.toBase58();
  if (!aIsInput && pool.mintB !== inputMint.toBase58()) {
    throw new Error('That token is not in this pool.');
  }
  return aIsInput
    ? {
        poolSource: new PublicKey(pool.tokenA),
        poolDestination: new PublicKey(pool.tokenB),
        sourceMint: new PublicKey(pool.mintA),
        destinationMint: new PublicKey(pool.mintB),
        sourceProgram: new PublicKey(pool.programA),
        destinationProgram: new PublicKey(pool.programB),
      }
    : {
        poolSource: new PublicKey(pool.tokenB),
        poolDestination: new PublicKey(pool.tokenA),
        sourceMint: new PublicKey(pool.mintB),
        destinationMint: new PublicKey(pool.mintA),
        sourceProgram: new PublicKey(pool.programB),
        destinationProgram: new PublicKey(pool.programA),
      };
}

/**
 * Quote a constant-product swap net of the pool's 0.30% total fee.
 *
 * These pools are shallow, so this is not a formality: a trade worth a few
 * percent of a reserve moves the price noticeably, and quoting it lets the
 * panel show the real number and set a minimum worth having.
 */
export function quote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const afterFee = (amountIn * 9970n) / 10_000n;
  return (reserveOut * afterFee) / (reserveIn + afterFee);
}

export function buildSwap(args: {
  pool: TokenSwapPool;
  user: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const o = orient(args.pool, args.inputMint);

  // instruction 1, then amount_in and minimum_amount_out as little-endian
  // u64. Built with DataView, not Buffer: the browser's Buffer is a polyfill
  // with none of Node's BigInt accessors.
  const data = Buffer.from(
    concatBytes([Uint8Array.from([1]), u64le(args.amountIn), u64le(args.minimumAmountOut)]),
  );

  return new TransactionInstruction({
    programId: SWAP_PROGRAM,
    keys: [
      { pubkey: new PublicKey(args.pool.swapAccount), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.pool.authority), isSigner: false, isWritable: false },
      { pubkey: args.user, isSigner: true, isWritable: false },
      { pubkey: ata(o.sourceMint, args.user, o.sourceProgram), isSigner: false, isWritable: true },
      { pubkey: o.poolSource, isSigner: false, isWritable: true },
      { pubkey: o.poolDestination, isSigner: false, isWritable: true },
      {
        pubkey: ata(o.destinationMint, args.user, o.destinationProgram),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: new PublicKey(args.pool.poolMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.pool.feeAccount), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}
