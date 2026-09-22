/**
 * Buy into a vault with nothing but SOL, through real pools.
 *
 *   npx tsx scripts/devnet_buy_with_sol.ts            # plan only
 *   npx tsx scripts/devnet_buy_with_sol.ts --send     # runs it
 *   SYMBOL=qSPY npx tsx scripts/devnet_buy_with_sol.ts --send
 *
 * Generates a wallet that has never existed, funds it with a little SOL and
 * nothing else, then wraps, swaps twice at the SPL Token Swap program and
 * deposits, ending with index tokens.
 *
 * The point is the last step. The vault program contains no exchange call
 * at all, so paying with an arbitrary asset is not a feature it implements;
 * it is instructions the caller puts in front of a deposit. Two of those
 * instructions here belong to a program we do not control, which is exactly
 * the arrangement mainnet would use with an aggregator.
 */
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, SEEDS } from './lib/codec.js';
import * as ix from './lib/ix.js';
import { buildSwap, quote, type Pool } from './lib/swap.js';
import { CLUSTER, banner, connection, loadDevnetState, WILL_SPEND } from './lib/env.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const SYMBOL = process.env.SYMBOL ?? 'qGOLD';
const SPEND_SOL = Number(process.env.SPEND_SOL ?? 0.03);

/** Slippage tolerance. These pools are shallow, so this is generous. */
const SLIPPAGE_BPS = 500n;

const balance = async (c: Connection, a: PublicKey) => {
  const i = await c.getAccountInfo(a);
  return i ? i.data.readBigUInt64LE(64) : 0n;
};

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner(`Quorum: buy into ${SYMBOL} with SOL alone`);

  const conn = connection();
  const state = loadDevnetState<DevnetState>();
  const pools = state.pools ?? {};
  const vault = MOCK_VAULTS.find((v) => v.symbol === SYMBOL);
  if (!vault) throw new Error(`No vault ${SYMBOL}`);

  // The holding to buy: the first one with a pool against mUSDC.
  const target = vault.wrappers.find((w) => pools[`${w.key}-mUSDC`]);
  if (!target) throw new Error(`No pool leads into ${SYMBOL}`);

  const usdc = new PublicKey(state.mints.mUSDC);
  const solPool = pools['wSOL-mUSDC'] as Pool;
  const legPool = pools[`${target.key}-mUSDC`] as Pool;
  const targetMint = new PublicKey(state.mints[target.key]);
  const targetProgram =
    target.multiplierSource === MULTIPLIER.Token2022ScaledUi
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

  console.log(`Route: ${SPEND_SOL} SOL -> mUSDC -> ${target.key} -> ${SYMBOL}`);
  console.log(`  SOL pool   ${solPool.swapAccount}`);
  console.log(`  leg pool   ${legPool.swapAccount}\n`);

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  const faucet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync('.devnet-faucet.json', 'utf8'))),
  );
  const user = Keypair.generate();
  console.log(`Fresh wallet ${user.publicKey.toBase58()}`);

  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: faucet.publicKey,
        toPubkey: user.publicKey,
        lamports: Math.round((SPEND_SOL + 0.05) * LAMPORTS_PER_SOL),
      }),
    ),
    [faucet],
    { commitment: 'confirmed' },
  );
  console.log(`Funded with ${(SPEND_SOL + 0.05).toFixed(3)} SOL and no tokens whatsoever\n`);

  const ata = (mint: PublicKey, program = TOKEN_PROGRAM_ID) =>
    getAssociatedTokenAddressSync(mint, user.publicKey, false, program, ASSOCIATED_TOKEN_PROGRAM_ID);

  // --- 1. wrap and swap into mUSDC ---
  const lamportsIn = BigInt(Math.round(SPEND_SOL * LAMPORTS_PER_SOL));
  const solReserves = await balance(conn, new PublicKey(solPool.tokenA));
  const usdcReserves = await balance(conn, new PublicKey(solPool.tokenB));
  const expectUsdc = quote(solReserves, usdcReserves, lamportsIn);

  const wsolAta = ata(WSOL);
  const tx1 = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, wsolAta, user.publicKey, WSOL),
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: wsolAta, lamports: Number(lamportsIn) }),
    createSyncNativeInstruction(wsolAta),
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, ata(usdc), user.publicKey, usdc,
    ),
    buildSwap({
      pool: solPool,
      user: user.publicKey,
      inputMint: WSOL,
      amountIn: lamportsIn,
      minimumAmountOut: (expectUsdc * (10_000n - SLIPPAGE_BPS)) / 10_000n,
    }),
  );
  const s1 = await sendAndConfirmTransaction(conn, tx1, [user], { commitment: 'confirmed' });
  const gotUsdc = await balance(conn, ata(usdc));
  console.log(`1. ${SPEND_SOL} SOL -> ${(Number(gotUsdc) / 1e6).toFixed(4)} mUSDC   ${s1.slice(0, 16)}...`);

  // --- 2. swap mUSDC into the holding ---
  const legUsdcReserve = await balance(conn, new PublicKey(legPool.tokenB));
  const legReserve = await balance(conn, new PublicKey(legPool.tokenA));
  const expectLeg = quote(legUsdcReserve, legReserve, gotUsdc);

  const tx2 = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, ata(targetMint, targetProgram), user.publicKey, targetMint, targetProgram,
    ),
    buildSwap({
      pool: legPool,
      user: user.publicKey,
      inputMint: usdc,
      amountIn: gotUsdc,
      minimumAmountOut: (expectLeg * (10_000n - SLIPPAGE_BPS)) / 10_000n,
    }),
  );
  const s2 = await sendAndConfirmTransaction(conn, tx2, [user], { commitment: 'confirmed' });
  const gotLeg = await balance(conn, ata(targetMint, targetProgram));
  console.log(
    `2. mUSDC -> ${(Number(gotLeg) / 10 ** target.decimals).toFixed(6)} ${target.key}   ${s2.slice(0, 16)}...`,
  );

  // --- 3. deposit it ---
  const vaultPda = SEEDS.vault(SYMBOL);
  const indexMint = SEEDS.indexMint(vaultPda);
  const legs = vault.wrappers.map((w) => ({ mint: new PublicKey(state.mints[w.key]) }));
  const extra: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey,
      getAssociatedTokenAddressSync(indexMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID),
      user.publicKey,
      indexMint,
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
  const tx3 = new Transaction().add(
    ...extra,
    ix.mintInKind({
      user: user.publicKey,
      symbol: SYMBOL,
      mint: targetMint,
      userWrapperAccount: ata(targetMint, targetProgram),
      userIndexAccount: getAssociatedTokenAddressSync(
        indexMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID,
      ),
      priceUpdate: new PublicKey(state.priceUpdates[SYMBOL]),
      wrapperTokenProgram: targetProgram,
      legs,
      amount: gotLeg,
      minIndexOut: 0n,
    }),
  );
  const s3 = await sendAndConfirmTransaction(conn, tx3, [user], { commitment: 'confirmed' });
  const index = await balance(
    conn,
    getAssociatedTokenAddressSync(indexMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID),
  );
  console.log(
    `3. ${target.key} -> ${(Number(index) / 1e9).toFixed(6)} ${SYMBOL}   ${s3.slice(0, 16)}...`,
  );

  if (index === 0n) throw new Error('no index tokens received');
  console.log('\nA wallet that held only SOL now holds the index token, through pools nobody here controls.\n');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
