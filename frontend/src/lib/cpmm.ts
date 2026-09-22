'use client';

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ata } from './program';
import type { CpmmPool } from './devnet';
import { concatBytes, readU64LE, u64le } from './bytes';

/**
 * Raydium's constant-product AMM, from the browser.
 *
 * Mirrors `scripts/lib/cpmm.ts`; `tests/frontend_parity.test.ts` compares
 * the bytes so the two cannot drift. It exists because the SPL Token Swap
 * build on devnet takes one token program for the whole pool and rejects a
 * Token-2022 mint, which would otherwise leave the two Scaled UI holdings
 * with no way in.
 *
 * Everything here reads bytes through `./bytes`, never through `Buffer`:
 * the browser's `Buffer` is a polyfill with none of Node's BigInt accessors.
 */
export const CPMM_PROGRAM = new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb');

/** The authority PDA every CPMM pool's vaults are owned by. */
export const CPMM_AUTHORITY = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
  CPMM_PROGRAM,
)[0];

/** Anchor's `swap_base_input` discriminator. */
const SWAP_BASE_INPUT = Uint8Array.from([143, 190, 90, 218, 196, 30, 51, 222]);

/** Fee config index 0 charges 25bps, expressed per million. */
export const CPMM_FEE_RATE = 2_500n;
const FEE_DENOMINATOR = 1_000_000n;

/**
 * Byte offsets into the pool state account: the fee counters sit after ten
 * pubkeys, five single-byte fields and `lp_supply`.
 */
const PROTOCOL_FEE_0 = 8 + 32 * 10 + 5 + 8;

/** The pool oriented so `inputMint` is the side being paid in. */
export function orientCpmm(pool: CpmmPool, inputMint: PublicKey) {
  const mint = inputMint.toBase58();
  if (mint !== pool.mint0 && mint !== pool.mint1) {
    throw new Error('That token is not in this pool.');
  }
  const zeroIn = mint === pool.mint0;
  return {
    zeroIn,
    inputMint: new PublicKey(zeroIn ? pool.mint0 : pool.mint1),
    outputMint: new PublicKey(zeroIn ? pool.mint1 : pool.mint0),
    inputVault: new PublicKey(zeroIn ? pool.vault0 : pool.vault1),
    outputVault: new PublicKey(zeroIn ? pool.vault1 : pool.vault0),
    inputProgram: new PublicKey(zeroIn ? pool.program0 : pool.program1),
    outputProgram: new PublicKey(zeroIn ? pool.program1 : pool.program0),
    outputDecimals: zeroIn ? pool.decimals1 : pool.decimals0,
  };
}

/** The three accounts a quote needs: the pool state and both vaults. */
export function cpmmReserveKeys(pool: CpmmPool): PublicKey[] {
  return [
    new PublicKey(pool.poolId),
    new PublicKey(pool.vault0),
    new PublicKey(pool.vault1),
  ];
}

/**
 * The tradable reserves, from the accounts `cpmmReserveKeys` names.
 *
 * The vaults hold more than the curve trades on: protocol and fund fees
 * accumulate in place rather than being swept out, and the pool state
 * tracks them. Quoting off the raw vault balance would promise an output
 * the program will not deliver.
 */
export function readCpmmReserves(
  pool: CpmmPool,
  infos: ({ data: Uint8Array } | null)[],
  inputMint: PublicKey,
): { reserveIn: bigint; reserveOut: bigint } {
  const [state, v0, v1] = infos;
  if (!state || !v0 || !v1) throw new Error('That pool is not on chain.');

  const owed = (i: 0 | 1) =>
    readU64LE(state.data, PROTOCOL_FEE_0 + i * 8) + // protocol
    readU64LE(state.data, PROTOCOL_FEE_0 + 16 + i * 8); // fund

  // A token account's amount sits at offset 64 in both token programs.
  const r0 = readU64LE(v0.data, 64) - owed(0);
  const r1 = readU64LE(v1.data, 64) - owed(1);

  return inputMint.toBase58() === pool.mint0
    ? { reserveIn: r0, reserveOut: r1 }
    : { reserveIn: r1, reserveOut: r0 };
}

/** Constant product after the fee is taken off the way in, as the CPMM does it. */
export function quoteCpmm(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  // Rounded up, in the pool's favour, matching the program.
  const fee = (amountIn * CPMM_FEE_RATE + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  const net = amountIn - fee;
  if (net <= 0n) return 0n;
  return (reserveOut * net) / (reserveIn + net);
}

/** `swap_base_input`: spend exactly `amountIn`, refuse under `minimumAmountOut`. */
export function buildCpmmSwap(args: {
  pool: CpmmPool;
  user: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const { pool, user, amountIn, minimumAmountOut } = args;
  const o = orientCpmm(pool, args.inputMint);

  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

  return new TransactionInstruction({
    programId: CPMM_PROGRAM,
    data: Buffer.from(
      concatBytes([SWAP_BASE_INPUT, u64le(amountIn), u64le(minimumAmountOut)]),
    ),
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      ro(CPMM_AUTHORITY),
      ro(new PublicKey(pool.ammConfig)),
      rw(new PublicKey(pool.poolId)),
      rw(ata(o.inputMint, user, o.inputProgram)),
      rw(ata(o.outputMint, user, o.outputProgram)),
      rw(o.inputVault),
      rw(o.outputVault),
      ro(o.inputProgram),
      ro(o.outputProgram),
      ro(o.inputMint),
      ro(o.outputMint),
      rw(new PublicKey(pool.observation)),
    ],
  });
}
