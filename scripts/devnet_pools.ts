/**
 * Create real devnet liquidity pools, so a visitor can buy a holding rather
 * than be handed one.
 *
 *   npx tsx scripts/devnet_pools.ts            # plan only, spends nothing
 *   npx tsx scripts/devnet_pools.ts --send     # creates them
 *
 * These are pools on the SPL Token Swap program, which is deployed on devnet
 * and which we do not control. That matters more than it sounds: the whole
 * reason the vault program contains no exchange call is that a swap should
 * be something the caller arranges and the vault merely checks the result
 * of. Demonstrating that against a third-party program is the point;
 * demonstrating it against an exchange we wrote ourselves would prove much
 * less.
 *
 * A mock exchange of our own was the alternative and is not affordable: the
 * deployer holds about 1.5 devnet SOL and the rent on even a small program
 * exceeds that, with airdrops rate-limited.
 *
 * Every pool is priced against `mUSDC`, a mock dollar created here, at the
 * rate its Pyth feed reports when the pool is made. They are shallow, so a
 * large trade will move them; they exist to make a demo possible, not to be
 * a market.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { CurveType, TokenSwap, TokenSwapLayout } from '@solana/spl-token-swap';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { POOL_PAIRS, USDC_DECIMALS } from '../config/devnet_pools.js';
import { MULTIPLIER } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';
import { writeFileSync } from 'node:fs';
import { DEVNET_STATE } from './lib/env.js';

const SWAP_PROGRAM = new PublicKey('SwapsVeCiPHMUAtzQWZw7RjsKjgCjhwU55QGu4U1Szw');

/**
 * The address the production Token Swap build requires to own each pool's
 * fee account. It is a property of that program, not a choice of ours.
 */
const FEE_OWNER = new PublicKey('HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN');

/** 0.25% to the pool, 0.05% to the owner. Ordinary constant-product fees. */
const FEES = {
  tradeFeeNumerator: 25n,
  tradeFeeDenominator: 10_000n,
  ownerTradeFeeNumerator: 5n,
  ownerTradeFeeDenominator: 10_000n,
  ownerWithdrawFeeNumerator: 0n,
  ownerWithdrawFeeDenominator: 0n,
  hostFeeNumerator: 0n,
  hostFeeDenominator: 0n,
};

const WSOL = 'So11111111111111111111111111111111111111112';

interface PoolRecord {
  pair: string;
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

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Mock pools are a devnet thing.');
  banner('Quorum: create devnet liquidity pools');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();
  const wrappers = new Map(
    MOCK_VAULTS.flatMap((v) => v.wrappers).map((w) => [w.key, w] as const),
  );

  // --- the mock dollar every pool is priced against ---
  let usdc = state.mints.mUSDC ? new PublicKey(state.mints.mUSDC) : null;
  if (!usdc) {
    console.log('mUSDC does not exist yet and will be created.\n');
  }

  console.log('Pools:');
  for (const p of POOL_PAIRS) {
    const existing = state.pools?.[p.key];
    console.log(
      `  ${p.key.padEnd(18)} ${String(p.baseAmount).padStart(10)} ${p.base} : ` +
        `${p.quoteAmount.toLocaleString()} mUSDC` +
        (existing ? `\n    ${'already at'.padEnd(16)} ${existing.swapAccount}` : ''),
    );
  }
  console.log();

  if (!WILL_SPEND) {
    const todo = POOL_PAIRS.filter((p) => !state.pools?.[p.key]).length;
    console.log(`${todo} pool(s) would be created, about 0.015 SOL of rent each.`);
    console.log('Re-run with --send.\n');
    return;
  }

  // --- mUSDC ---
  if (!usdc) {
    const mintKp = Keypair.generate();
    const lamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const ata = getAssociatedTokenAddressSync(mintKp.publicKey, kp.publicKey);
    const supply = POOL_PAIRS.reduce((a, p) => a + p.quoteAmount, 0) * 4;
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintKp.publicKey, USDC_DECIMALS, kp.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        kp.publicKey, ata, kp.publicKey, mintKp.publicKey,
      ),
      createMintToInstruction(
        mintKp.publicKey, ata, kp.publicKey,
        BigInt(Math.round(supply)) * 10n ** BigInt(USDC_DECIMALS),
      ),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [kp, mintKp], { commitment: 'confirmed' });
    usdc = mintKp.publicKey;
    state.mints.mUSDC = usdc.toBase58();
    console.log(`  mUSDC ${usdc.toBase58()}, ${supply.toLocaleString()} minted  ${sig.slice(0, 16)}...`);
  }

  state.pools ??= {};

  // `ONLY=<key>` creates just that pool, for trying the flow once before
  // spending rent on all of them.
  const only = process.env.ONLY;
  for (const p of POOL_PAIRS) {
    if (only && p.key !== only) continue;
    if (state.pools[p.key]) {
      console.log(`  ${p.key.padEnd(18)} exists, skipping`);
      continue;
    }

    const isNative = p.base === 'wSOL';
    const w = wrappers.get(p.base);
    const mintA = isNative ? new PublicKey(WSOL) : new PublicKey(state.mints[p.base]);
    const decimalsA = isNative ? 9 : (w?.decimals ?? 9);
    const programA =
      !isNative && w?.multiplierSource === MULTIPLIER.Token2022ScaledUi
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    try {
      const record = await createPool(conn, kp, {
        key: p.key,
        mintA,
        decimalsA,
        programA,
        amountA: p.baseAmount,
        mintB: usdc,
        amountB: p.quoteAmount,
        isNative,
      });
      state.pools[p.key] = record;
      console.log(`  ${p.key.padEnd(18)} ${record.swapAccount}`);
    } catch (e) {
      const m = (e as Error).message;
      const why =
        /Program log: (Error:[^"]+)/.exec(m)?.[1] ??
        /custom program error: (\w+)/.exec(m)?.[0] ??
        m.replace(/\s+/g, ' ').slice(0, 200);
      console.log(`  ${p.key.padEnd(18)} FAILED: ${why}`);
    }

    writeFileSync(DEVNET_STATE, `${JSON.stringify(state, null, 2)}\n`);
  }

  console.log(`\nRecorded in ${DEVNET_STATE}. Run npm run devnet:sync.\n`);
}

/**
 * One pool, in two transactions.
 *
 * Split because the accounts have to exist and hold their liquidity before
 * `initialize` runs: the program reads both balances to mint the first pool
 * tokens, and rejects a pool that starts empty.
 */
async function createPool(
  conn: ReturnType<typeof connection>,
  kp: Keypair,
  a: {
    key: string;
    mintA: PublicKey;
    decimalsA: number;
    programA: PublicKey;
    amountA: number;
    mintB: PublicKey;
    amountB: number;
    isNative: boolean;
  },
): Promise<PoolRecord> {
  const swapKp = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync(
    [swapKp.publicKey.toBuffer()],
    SWAP_PROGRAM,
  );

  const tokenA = Keypair.generate();
  const tokenB = Keypair.generate();
  const poolMint = Keypair.generate();
  const accountRent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const mintRent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);

  const rawA = BigInt(Math.round(a.amountA * 10 ** a.decimalsA));
  const rawB = BigInt(Math.round(a.amountB * 10 ** USDC_DECIMALS));

  // --- 1. the two reserves, funded ---
  const setup = new Transaction();
  for (const [kpAcct, mint, program] of [
    [tokenA, a.mintA, a.programA],
    [tokenB, a.mintB, TOKEN_PROGRAM_ID],
  ] as const) {
    setup.add(
      SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: kpAcct.publicKey,
        space: ACCOUNT_SIZE,
        lamports: accountRent,
        programId: program,
      }),
      createInitializeAccountInstruction(kpAcct.publicKey, mint, authority, program),
    );
  }

  if (a.isNative) {
    // Wrapping straight into the reserve: a transfer and a sync, no source
    // account of ours needed.
    setup.add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: tokenA.publicKey,
        lamports: Number(rawA),
      }),
      createSyncNativeInstruction(tokenA.publicKey),
    );
  } else {
    setup.add(
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(a.mintA, kp.publicKey, false, a.programA, ASSOCIATED_TOKEN_PROGRAM_ID),
        a.mintA,
        tokenA.publicKey,
        kp.publicKey,
        rawA,
        a.decimalsA,
        [],
        a.programA,
      ),
    );
  }
  setup.add(
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(a.mintB, kp.publicKey),
      a.mintB,
      tokenB.publicKey,
      kp.publicKey,
      rawB,
      USDC_DECIMALS,
    ),
  );
  await sendAndConfirmTransaction(conn, setup, [kp, tokenA, tokenB], { commitment: 'confirmed' });

  // --- 2. the pool token, its fee account, and initialize ---
  const feeAccount = getAssociatedTokenAddressSync(poolMint.publicKey, FEE_OWNER, true);
  const poolTokens = getAssociatedTokenAddressSync(poolMint.publicKey, kp.publicKey);
  const swapRent = await conn.getMinimumBalanceForRentExemption(TokenSwapLayout.span);

  const init = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: kp.publicKey,
      newAccountPubkey: poolMint.publicKey,
      space: MINT_SIZE,
      lamports: mintRent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(poolMint.publicKey, 2, authority, null),
    createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey, feeAccount, FEE_OWNER, poolMint.publicKey,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey, poolTokens, kp.publicKey, poolMint.publicKey,
    ),
    SystemProgram.createAccount({
      fromPubkey: kp.publicKey,
      newAccountPubkey: swapKp.publicKey,
      space: TokenSwapLayout.span,
      lamports: swapRent,
      programId: SWAP_PROGRAM,
    }),
    TokenSwap.createInitSwapInstruction(
      swapKp,
      authority,
      tokenA.publicKey,
      tokenB.publicKey,
      poolMint.publicKey,
      feeAccount,
      poolTokens,
      TOKEN_PROGRAM_ID,
      SWAP_PROGRAM,
      FEES.tradeFeeNumerator,
      FEES.tradeFeeDenominator,
      FEES.ownerTradeFeeNumerator,
      FEES.ownerTradeFeeDenominator,
      FEES.ownerWithdrawFeeNumerator,
      FEES.ownerWithdrawFeeDenominator,
      FEES.hostFeeNumerator,
      FEES.hostFeeDenominator,
      CurveType.ConstantProduct,
    ),
  );
  await sendAndConfirmTransaction(conn, init, [kp, poolMint, swapKp], { commitment: 'confirmed' });

  return {
    pair: a.key,
    swapAccount: swapKp.publicKey.toBase58(),
    authority: authority.toBase58(),
    poolMint: poolMint.publicKey.toBase58(),
    tokenA: tokenA.publicKey.toBase58(),
    tokenB: tokenB.publicKey.toBase58(),
    mintA: a.mintA.toBase58(),
    mintB: a.mintB.toBase58(),
    feeAccount: feeAccount.toBase58(),
    programA: a.programA.toBase58(),
    programB: TOKEN_PROGRAM_ID.toBase58(),
    decimalsA: a.decimalsA,
  };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
