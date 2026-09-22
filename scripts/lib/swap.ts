/**
 * Swapping at the devnet pools.
 *
 * One helper, because a swap is the same instruction whichever way round the
 * pool is stored: the program cares which reserve is the source, not which
 * one the pool calls A. Getting that backwards drains the wrong reserve, so
 * the direction is worked out here once from the input mint.
 *
 * Nothing in the Quorum program knows any of this exists. A swap built here
 * is an ordinary instruction that happens to sit next to a deposit or
 * between a loan and its settlement.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export const SWAP_PROGRAM = new PublicKey('SwapsVeCiPHMUAtzQWZw7RjsKjgCjhwU55QGu4U1Szw');

export interface Pool {
  swapAccount: string;
  authority: string;
  poolMint: string;
  tokenA: string;
  tokenB: string;
  mintA: string;
  mintB: string;
  feeAccount: string;
  programA: string;
  programB: string;
  decimalsA: number;
}

/** The reserves of a pool, oriented so `source` matches the input mint. */
export function orient(pool: Pool, inputMint: PublicKey) {
  const aIsInput = pool.mintA === inputMint.toBase58();
  if (!aIsInput && pool.mintB !== inputMint.toBase58()) {
    throw new Error(`${inputMint.toBase58()} is not in this pool`);
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
 * Quote a constant-product swap, net of the pool's 0.30% total fee.
 *
 * Used to set a sane `minimumAmountOut` rather than passing zero. A shallow
 * pool moves a long way on a modest trade, and a caller who accepts any
 * output is the one who finds out the hard way.
 */
export function quote(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  const afterFee = (amountIn * 9970n) / 10_000n;
  return (reserveOut * afterFee) / (reserveIn + afterFee);
}

/**
 * The swap instruction, built by hand.
 *
 * The published SDK emits the newer fourteen-account layout, which carries
 * both mints and a token program for each side. The program deployed on
 * devnet is the earlier build: ten accounts and a single token program. It
 * rejects the newer shape with "the provided token program does not match",
 * error 0x18, which is what it looks like when an account list is read at
 * the wrong offsets rather than anything being genuinely wrong.
 *
 * Writing it out here rather than pinning an older SDK keeps the account
 * order visible next to the comment explaining it.
 */
export function buildSwap(args: {
  pool: Pool;
  user: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const o = orient(args.pool, args.inputMint);
  const ata = (mint: PublicKey, program: PublicKey) =>
    getAssociatedTokenAddressSync(mint, args.user, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);

  // instruction 1, then amount_in and minimum_amount_out as little-endian u64.
  const data = Buffer.alloc(17);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(args.amountIn, 1);
  data.writeBigUInt64LE(args.minimumAmountOut, 9);

  return new TransactionInstruction({
    programId: SWAP_PROGRAM,
    keys: [
      { pubkey: new PublicKey(args.pool.swapAccount), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.pool.authority), isSigner: false, isWritable: false },
      { pubkey: args.user, isSigner: true, isWritable: false },
      { pubkey: ata(o.sourceMint, o.sourceProgram), isSigner: false, isWritable: true },
      { pubkey: o.poolSource, isSigner: false, isWritable: true },
      { pubkey: o.poolDestination, isSigner: false, isWritable: true },
      { pubkey: ata(o.destinationMint, o.destinationProgram), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.pool.poolMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.pool.feeAccount), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}
