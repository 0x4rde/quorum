/**
 * Create the devnet mock wrapper mints and record them in `config/devnet.json`.
 *
 *   npx tsx scripts/devnet_mocks.ts            # plan only, spends nothing
 *   npx tsx scripts/devnet_mocks.ts --send     # creates the mints
 *
 * `config/devnet_wrappers.ts` says what each mock stands for and why it is
 * shaped the way it is. This script only builds them.
 *
 * Idempotent: a mint already recorded in `config/devnet.json` and present
 * on-chain is left alone, so a partial run can be repeated. Mint authority
 * stays with the deployer, because the demo needs to hand test tokens out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, SEEDS } from './lib/codec.js';
import { CLUSTER, DEVNET_STATE, PROGRAM_ID, banner, connection, payer, WILL_SPEND } from './lib/env.js';

const isScaledUi = (m: number) => m === MULTIPLIER.Token2022ScaledUi;
const programFor = (m: number) => (isScaledUi(m) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);

function loadState(authority: PublicKey): DevnetState {
  if (existsSync(DEVNET_STATE)) {
    return JSON.parse(readFileSync(DEVNET_STATE, 'utf8')) as DevnetState;
  }
  return {
    cluster: 'devnet',
    programId: PROGRAM_ID,
    authority: authority.toBase58(),
    createdAt: new Date().toISOString(),
    mints: {},
    vaults: {},
    priceUpdates: {},
  };
}

async function main() {
  if (CLUSTER !== 'devnet') {
    throw new Error('Mock mints are a devnet thing. Refusing to run against mainnet.');
  }
  banner('Quorum: create devnet mock wrapper mints');

  const conn = connection();
  const kp = payer();
  const state = loadState(kp.publicKey);

  const wrappers = MOCK_VAULTS.flatMap((v) =>
    v.wrappers.map((w) => ({ ...w, vaultSymbol: v.symbol })),
  );

  console.log('Mock wrappers:');
  for (const w of wrappers) {
    const prog = isScaledUi(w.multiplierSource) ? 'Token-2022' : 'SPL Token';
    const ext = w.existingMint
      ? ' native, not minted'
      : isScaledUi(w.multiplierSource)
        ? ` scaled-ui x${w.initialMultiplier}`
        : '';
    const known = state.mints[w.key];
    console.log(
      `  ${w.vaultSymbol.padEnd(6)} ${w.key.padEnd(9)} ${String(w.decimals).padStart(2)}dp ` +
        `${prog.padEnd(10)}${ext.padEnd(22)} stands for ${w.standsFor}` +
        (known ? `\n           already at ${known}` : ''),
    );
  }
  console.log();

  if (!WILL_SPEND) {
    const toCreate = wrappers.filter((w) => !state.mints[w.key]);
    console.log(`${toCreate.length} mint(s) would be created, plus one token account each.`);
    console.log('Roughly 0.004 SOL of rent per mint. Re-run with --send.\n');
    return;
  }

  for (const w of wrappers) {
    // Wrapped SOL exists on every cluster and cannot be minted by us. Record
    // the canonical mint and wrap enough SOL to seed the vault later.
    if (w.existingMint) {
      state.mints[w.key] = w.existingMint;
      const mint = new PublicKey(w.existingMint);
      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, TOKEN_PROGRAM_ID);
      const held = await conn.getAccountInfo(ata);
      const have = held ? Number(held.data.readBigUInt64LE(64)) / 1e9 : 0;
      const want = (w.seedTokens ?? 0) * 2; // enough to seed and still demo
      if (have >= want) {
        console.log(`  ${w.key.padEnd(9)} exists, holding ${have.toFixed(4)}`);
        continue;
      }
      const top = want - have;
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          kp.publicKey, ata, kp.publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: ata,
          lamports: Math.round(top * 1e9),
        }),
        createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      console.log(`  ${w.key.padEnd(9)} wrapped ${top.toFixed(4)} SOL  ${sig.slice(0, 16)}...`);
      continue;
    }

    if (state.mints[w.key]) {
      const existing = await conn.getAccountInfo(new PublicKey(state.mints[w.key]));
      if (existing) {
        console.log(`  ${w.key.padEnd(9)} exists, skipping`);
        continue;
      }
    }

    const mintKp = Keypair.generate();
    const tokenProgram = programFor(w.multiplierSource);
    const scaled = isScaledUi(w.multiplierSource);
    const space = scaled ? getMintLen([ExtensionType.ScaledUiAmountConfig]) : getMintLen([]);
    const lamports = await conn.getMinimumBalanceForRentExemption(space);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space,
        lamports,
        programId: tokenProgram,
      }),
    );

    // The extension has to be initialised before the mint itself, or
    // InitializeMint2 seals the account and the config has nowhere to go.
    if (scaled) {
      tx.add(
        createInitializeScaledUiAmountConfigInstruction(
          mintKp.publicKey,
          kp.publicKey, // authority: lets the keeper push a new multiplier later
          w.initialMultiplier ?? 1,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
    }

    tx.add(
      createInitializeMint2Instruction(
        mintKp.publicKey,
        w.decimals,
        kp.publicKey,
        null, // no freeze authority: a mock must not be able to lock the vault out
        tokenProgram,
      ),
    );

    const ata = getAssociatedTokenAddressSync(
      mintKp.publicKey,
      kp.publicKey,
      false,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        kp.publicKey,
        ata,
        kp.publicKey,
        mintKp.publicKey,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(
        mintKp.publicKey,
        ata,
        kp.publicKey,
        BigInt(w.supply) * 10n ** BigInt(w.decimals),
        [],
        tokenProgram,
      ),
    );

    const sig = await sendAndConfirmTransaction(conn, tx, [kp, mintKp], {
      commitment: 'confirmed',
    });
    state.mints[w.key] = mintKp.publicKey.toBase58();
    console.log(`  ${w.key.padEnd(9)} ${mintKp.publicKey.toBase58()}  ${sig.slice(0, 16)}...`);
  }

  for (const v of MOCK_VAULTS) {
    const vault = SEEDS.vault(v.symbol);
    state.vaults[v.symbol] = {
      vault: vault.toBase58(),
      indexMint: SEEDS.indexMint(vault).toBase58(),
    };
  }

  writeFileSync(DEVNET_STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`\nWrote ${DEVNET_STATE}.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
