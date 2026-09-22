/**
 * Set up the devnet faucet, so a visitor can try the app without asking
 * anyone for tokens.
 *
 *   npx tsx scripts/devnet_faucet.ts                  # plan only
 *   npx tsx scripts/devnet_faucet.ts --send           # create and fund it
 *   npx tsx scripts/devnet_faucet.ts --print-secret   # print it for Vercel
 *
 * It creates a dedicated keypair at `.devnet-faucet.json` (gitignored),
 * funds it with a little devnet SOL, and moves the mint authority of the
 * seven mock wrapper mints from the deployer to it.
 *
 * ## Why a separate key, and what it can do
 *
 * The faucet key has to live in a serverless environment variable to be
 * useful, so the question is what someone who obtained it could do. The
 * answer is deliberately small: mint valueless devnet mock tokens, and spend
 * the small SOL balance parked here. It is not the deployer, not the vault
 * authority, not the guardian, and not the program's upgrade authority, so it
 * cannot pause a vault, change a parameter, move a vault balance or upgrade
 * anything. The worst case is a bloated devnet basket, fixed by re-running
 * the setup.
 *
 * The deployer key never leaves this machine. That separation is the entire
 * point of this script; without it the only way to make the faucet work
 * would be to upload the key that owns everything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createSetAuthorityInstruction,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

const FAUCET_KEYPAIR = '.devnet-faucet.json';

/** Enough for a few thousand drips at devnet fees, and no more. */
const FAUCET_SOL = 0.6;

function loadOrCreateFaucet(): { kp: Keypair; created: boolean } {
  if (existsSync(FAUCET_KEYPAIR)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(FAUCET_KEYPAIR, 'utf8')));
    return { kp: Keypair.fromSecretKey(secret), created: false };
  }
  const kp = Keypair.generate();
  writeFileSync(FAUCET_KEYPAIR, `${JSON.stringify(Array.from(kp.secretKey))}\n`);
  return { kp, created: true };
}

async function main() {
  if (CLUSTER !== 'devnet') {
    throw new Error('The faucet mints mock tokens. Devnet only.');
  }

  const { kp: faucet, created } = loadOrCreateFaucet();

  if (process.argv.includes('--print-secret')) {
    // Deliberately behind its own flag so it cannot end up in a log by
    // accident. Paste this into the Vercel environment variable, nowhere else.
    console.log(JSON.stringify(Array.from(faucet.secretKey)));
    return;
  }

  banner('Quorum: devnet faucet setup');
  const conn = connection();
  const deployer = payer();
  const state = loadDevnetState<DevnetState>();

  console.log(`Faucet key  ${faucet.publicKey.toBase58()}${created ? '  (just generated)' : ''}`);
  console.log(`Secret at   ${FAUCET_KEYPAIR} (gitignored)\n`);

  const balance = (await conn.getBalance(faucet.publicKey)) / LAMPORTS_PER_SOL;
  const topUp = Math.max(0, FAUCET_SOL - balance);

  // mUSDC is the token a visitor is actually handed, so the faucet has to
  // be able to mint it. Wrapped SOL is skipped: nobody owns its mint.
  const wrappers = [
    ...MOCK_VAULTS.flatMap((v) => v.wrappers).filter((w) => !w.existingMint),
    ...(state.mints.mUSDC
      ? [{ key: 'mUSDC', multiplierSource: MULTIPLIER.Fixed, decimals: 6 } as const]
      : []),
  ];
  const toMove: { key: string; mint: PublicKey; tokenProgram: PublicKey }[] = [];

  for (const w of wrappers) {
    const mint = new PublicKey(state.mints[w.key]);
    const tokenProgram =
      w.multiplierSource === MULTIPLIER.Token2022ScaledUi
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
    const info = await conn.getAccountInfo(mint);
    if (!info) throw new Error(`${w.key} mint is missing on-chain`);
    // Mint layout: mint_authority_option(4) mint_authority(32) at offset 0.
    const hasAuthority = info.data.readUInt32LE(0) === 1;
    const authority = hasAuthority ? new PublicKey(info.data.subarray(4, 36)) : null;
    if (authority?.equals(faucet.publicKey)) {
      console.log(`  ok    ${w.key.padEnd(9)} authority already the faucet`);
    } else if (authority?.equals(deployer.publicKey)) {
      toMove.push({ key: w.key, mint, tokenProgram });
    } else {
      throw new Error(
        `${w.key} mint authority is ${authority?.toBase58() ?? 'none'}, ` +
          'which is neither the deployer nor the faucet. Refusing to guess.',
      );
    }
  }

  console.log();
  console.log(`Faucet holds ${balance.toFixed(4)} SOL; would top up by ${topUp.toFixed(4)}.`);
  console.log(`${toMove.length} mint authority transfer(s): ${toMove.map((m) => m.key).join(', ') || 'none'}`);
  console.log();

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  if (topUp > 0.0001) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: faucet.publicKey,
        lamports: Math.round(topUp * LAMPORTS_PER_SOL),
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: 'confirmed' });
    console.log(`  funded faucet with ${topUp.toFixed(4)} SOL  ${sig.slice(0, 16)}...`);
  }

  for (const m of toMove) {
    const tx = new Transaction().add(
      createSetAuthorityInstruction(
        m.mint,
        deployer.publicKey,
        AuthorityType.MintTokens,
        faucet.publicKey,
        [],
        m.tokenProgram,
      ),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: 'confirmed' });
    console.log(`  ${m.key.padEnd(9)} mint authority -> faucet  ${sig.slice(0, 16)}...`);
  }

  console.log(`
Done. To let the deployed site serve test tokens, set this in Vercel:

  FAUCET_SECRET_KEY = the output of
      npx tsx scripts/devnet_faucet.ts --print-secret

Without it the site still reads and still mints for anyone who already holds
mock tokens; only the "get test USDC" button goes quiet.
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
