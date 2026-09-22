/**
 * Raydium's constant-product AMM, the second devnet venue.
 *
 * The SPL Token Swap build deployed on devnet takes one token program for
 * the whole pool and rejects a Token-2022 mint outright, which left mSPYx
 * and mMSTRx — the two Scaled UI holdings — with no pool at all. Raydium's
 * CPMM takes a token program per side, so those two live here and everything
 * else stays on Token Swap. `config/devnet.json` tags each pool with `kind`
 * and the callers dispatch on it.
 *
 * Nothing in the Quorum program knows either venue exists. A swap built here
 * is an ordinary instruction that happens to sit next to a deposit, which is
 * the whole point of the loan-and-settle design: the vault checks the
 * measured result of a trade it never signed.
 *
 * Opening a pool is not here. That is a one-off fixture chore, not part of
 * the product, and the product needs only the addresses it left behind.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

/** Raydium's CPMM on devnet. A different address from its mainnet build. */
export const CPMM_PROGRAM = new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb');

/** Anchor's `swap_base_input` discriminator. */
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

/**
 * Fee config index 0 charges 25bps, expressed per million. Both our pools
 * were opened against it; a pool on another config would quote differently,
 * which is why `ammConfig` is recorded alongside each one.
 */
export const CPMM_FEE_RATE = 2_500n;
const FEE_DENOMINATOR = 1_000_000n;

/**
 * A pool as `config/devnet.json` stores it. Sides are numbered rather than
 * named, because the program derives the pool address from the two mints in
 * pubkey order and accepts no other arrangement. Which side is the holding
 * and which the dollar is worked out from the mint, never from the position.
 */
export interface CpmmPool {
  kind: 'cpmm';
  pair: string;
  poolId: string;
  ammConfig: string;
  observation: string;
  lpMint: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  program0: string;
  program1: string;
  decimals0: number;
  decimals1: number;
}

/** True for a record written by the CPMM path rather than the Token Swap one. */
export function isCpmm(pool: { kind?: string }): pool is CpmmPool {
  return pool.kind === 'cpmm';
}

const seed = (s: string) => Buffer.from(s, 'utf8');
const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, CPMM_PROGRAM)[0];

/** The single authority PDA every CPMM pool's vaults are owned by. */
export const CPMM_AUTHORITY = pda([seed('vault_and_lp_mint_auth_seed')]);

/** Every address a pool needs, derived from its config and its two mints. */
export function cpmmPdas(ammConfig: PublicKey, mint0: PublicKey, mint1: PublicKey) {
  const poolId = pda([seed('pool'), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer()]);
  return {
    poolId,
    lpMint: pda([seed('pool_lp_mint'), poolId.toBuffer()]),
    vault0: pda([seed('pool_vault'), poolId.toBuffer(), mint0.toBuffer()]),
    vault1: pda([seed('pool_vault'), poolId.toBuffer(), mint1.toBuffer()]),
    observation: pda([seed('observation'), poolId.toBuffer()]),
  };
}

/** The pool oriented so `input` is the side being paid in. */
export function orientCpmm(pool: CpmmPool, inputMint: PublicKey) {
  const mint = inputMint.toBase58();
  if (mint !== pool.mint0 && mint !== pool.mint1) {
    throw new Error(`${mint} is not in ${pool.pair}`);
  }
  const zeroIn = mint === pool.mint0;
  return {
    inputMint: new PublicKey(zeroIn ? pool.mint0 : pool.mint1),
    outputMint: new PublicKey(zeroIn ? pool.mint1 : pool.mint0),
    inputVault: new PublicKey(zeroIn ? pool.vault0 : pool.vault1),
    outputVault: new PublicKey(zeroIn ? pool.vault1 : pool.vault0),
    inputProgram: new PublicKey(zeroIn ? pool.program0 : pool.program1),
    outputProgram: new PublicKey(zeroIn ? pool.program1 : pool.program0),
    inputDecimals: zeroIn ? pool.decimals0 : pool.decimals1,
    outputDecimals: zeroIn ? pool.decimals1 : pool.decimals0,
  };
}

/**
 * Constant product after a 25bps fee taken off the way in, which is how the
 * CPMM charges: the fee never enters the curve.
 *
 * `reserveIn` and `reserveOut` are the tradable reserves, which are the
 * vault balances less the protocol and fund fees the pool is holding on
 * behalf of Raydium. Passing raw vault balances instead overstates the
 * output by that amount, so read them with `cpmmReserves`.
 */
export function quoteCpmm(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  // Rounded up, in the pool's favour, exactly as the program does it.
  const fee = (amountIn * CPMM_FEE_RATE + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  const net = amountIn - fee;
  if (net <= 0n) return 0n;
  return (reserveOut * net) / (reserveIn + net);
}

/**
 * Byte offsets into the pool state account. The fee counters sit after ten
 * pubkeys and five single-byte fields, then `lp_supply`.
 */
const POOL_STATE = {
  mint0: 8 + 32 * 5,
  protocolFee0: 8 + 32 * 10 + 5 + 8,
} as const;

/**
 * The tradable reserves, oriented for a swap paying in `inputMint`.
 *
 * The vaults hold more than the curve trades on: protocol and fund fees
 * accumulate in place and are tracked in the pool state rather than being
 * swept out. Quoting off the raw vault balance would therefore promise an
 * output the program will not deliver.
 */
export async function cpmmReserves(
  fetch: (keys: PublicKey[]) => Promise<({ data: Buffer } | null)[]>,
  pool: CpmmPool,
  inputMint: PublicKey,
): Promise<{ reserveIn: bigint; reserveOut: bigint }> {
  const [state, v0, v1] = await fetch([
    new PublicKey(pool.poolId),
    new PublicKey(pool.vault0),
    new PublicKey(pool.vault1),
  ]);
  if (!state || !v0 || !v1) throw new Error(`${pool.pair} is not on chain`);

  const owed = (i: 0 | 1) =>
    state.data.readBigUInt64LE(POOL_STATE.protocolFee0 + i * 8) + // protocol
    state.data.readBigUInt64LE(POOL_STATE.protocolFee0 + 16 + i * 8); // fund

  // A token account's amount sits at offset 64, the same in both programs.
  const r0 = v0.data.readBigUInt64LE(64) - owed(0);
  const r1 = v1.data.readBigUInt64LE(64) - owed(1);

  const zeroIn = inputMint.toBase58() === pool.mint0;
  return zeroIn ? { reserveIn: r0, reserveOut: r1 } : { reserveIn: r1, reserveOut: r0 };
}

/** Sanity check that the offsets above still describe this account. */
export function poolStateMint0(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(POOL_STATE.mint0, POOL_STATE.mint0 + 32));
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
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
    data: Buffer.concat([SWAP_BASE_INPUT, u64(amountIn), u64(minimumAmountOut)]),
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      ro(CPMM_AUTHORITY),
      ro(new PublicKey(pool.ammConfig)),
      rw(new PublicKey(pool.poolId)),
      rw(getAssociatedTokenAddressSync(o.inputMint, user, false, o.inputProgram)),
      rw(getAssociatedTokenAddressSync(o.outputMint, user, false, o.outputProgram)),
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
