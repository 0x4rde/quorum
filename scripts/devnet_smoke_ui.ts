/**
 * End-to-end smoke test of the browser path, with a throwaway wallet.
 *
 *   npx tsx scripts/devnet_smoke_ui.ts            # plan only
 *   npx tsx scripts/devnet_smoke_ui.ts --send     # runs it
 *
 * Generates a wallet that has never existed, funds it from the faucet the
 * same way `/api/faucet` does, then mints and redeems using
 * `frontend/src/lib/program.ts`, the exact module the page ships. If this
 * passes, a visitor connecting a fresh wallet gets the same result.
 *
 * Importing the frontend's builders rather than the scripts' is the point.
 * `tests/frontend_parity.test.ts` already proves the two agree byte for
 * byte, but that is an assertion about encoding; this is the question of
 * whether the bytes are accepted on chain.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import {
  TOKEN_2022_PROGRAM as FE_TOKEN_2022,
  TOKEN_PROGRAM as FE_TOKEN,
  ata,
  createAtaIdempotent,
  mintInKind,
  redeemInKind,
} from '../frontend/src/lib/program.js';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, WILL_SPEND } from './lib/env.js';

const SYMBOL = process.env.SYMBOL ?? 'qGOLD';
const DRIP_TOKENS = 5;
const DRIP_SOL = 0.05;

async function balanceOf(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? info.data.readBigUInt64LE(64) : 0n;
}

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner(`Quorum: browser-path smoke test on ${SYMBOL}`);

  if (!existsSync('.devnet-faucet.json')) {
    throw new Error('No .devnet-faucet.json. Run scripts/devnet_faucet.ts --send first.');
  }
  const faucet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync('.devnet-faucet.json', 'utf8'))),
  );

  const conn = connection();
  const state = loadDevnetState<DevnetState>();
  const config = MOCK_VAULTS.find((v) => v.symbol === SYMBOL);
  if (!config) throw new Error(`No vault ${SYMBOL}`);

  const legs = config.wrappers.map((w) => {
    const tokenProgram =
      w.multiplierSource === MULTIPLIER.Token2022ScaledUi ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    return { ...w, mintKey: new PublicKey(state.mints[w.key]), tokenProgram };
  });
  const priceAccount = new PublicKey(state.priceUpdates[SYMBOL]);

  const user = Keypair.generate();
  console.log(`Throwaway wallet ${user.publicKey.toBase58()}`);
  console.log(`Faucet           ${faucet.publicKey.toBase58()}`);
  console.log(`Legs             ${legs.map((l) => l.key).join(', ')}\n`);

  if (!WILL_SPEND) {
    console.log('Would: drip SOL and tokens, mint 1 of leg 0, redeem half, check balances.');
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  // --- 1. Faucet, mirroring what /api/faucet builds -------------------------
  const drip = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: faucet.publicKey,
      toPubkey: user.publicKey,
      lamports: Math.round(DRIP_SOL * LAMPORTS_PER_SOL),
    }),
  );
  for (const l of legs) {
    const account = getAssociatedTokenAddressSync(
      l.mintKey, user.publicKey, true, l.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    drip.add(
      createAssociatedTokenAccountIdempotentInstruction(
        faucet.publicKey, account, user.publicKey, l.mintKey, l.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(
        l.mintKey, account, faucet.publicKey,
        BigInt(DRIP_TOKENS) * 10n ** BigInt(l.decimals), [], l.tokenProgram,
      ),
    );
  }
  console.log(`  1. faucet    ${(await sendAndConfirmTransaction(conn, drip, [faucet], { commitment: 'confirmed' })).slice(0, 16)}...`);

  // --- 2. Mint, through the frontend's own builders -------------------------
  const feLegs = legs.map((l) => ({
    mint: l.mintKey,
    tokenProgram: l.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? FE_TOKEN_2022 : FE_TOKEN,
  }));
  const indexMintKey = new PublicKey(state.vaults[SYMBOL].indexMint);
  const leg0 = legs[0];

  const mintTx = new Transaction().add(
    createAtaIdempotent({
      payer: user.publicKey, owner: user.publicKey,
      mint: indexMintKey, tokenProgram: FE_TOKEN_2022,
    }),
    mintInKind({
      user: user.publicKey,
      symbol: SYMBOL,
      mint: leg0.mintKey,
      wrapperTokenProgram: feLegs[0].tokenProgram,
      priceUpdate: priceAccount,
      legs: feLegs,
      amount: 10n ** BigInt(leg0.decimals),
      minIndexOut: 0n,
    }),
  );
  console.log(`  2. mint      ${(await sendAndConfirmTransaction(conn, mintTx, [user], { commitment: 'confirmed' })).slice(0, 16)}...`);

  const userIndex = ata(indexMintKey, user.publicKey, FE_TOKEN_2022);
  const afterMint = await balanceOf(conn, userIndex);
  console.log(`     holds ${(Number(afterMint) / 1e9).toFixed(6)} ${SYMBOL}`);
  if (afterMint === 0n) throw new Error('mint produced no index tokens');

  // --- 3. Redeem half -------------------------------------------------------
  const redeemTx = new Transaction().add(
    ...feLegs.map((l) =>
      createAtaIdempotent({
        payer: user.publicKey, owner: user.publicKey,
        mint: l.mint, tokenProgram: l.tokenProgram,
      }),
    ),
    redeemInKind({
      user: user.publicKey,
      symbol: SYMBOL,
      legs: feLegs,
      indexAmount: afterMint / 2n,
    }),
  );
  console.log(`  3. redeem    ${(await sendAndConfirmTransaction(conn, redeemTx, [user], { commitment: 'confirmed' })).slice(0, 16)}...`);

  const afterRedeem = await balanceOf(conn, userIndex);
  console.log(`     holds ${(Number(afterRedeem) / 1e9).toFixed(6)} ${SYMBOL}\n`);

  console.log('Wrapper balances returned to the wallet:');
  for (const l of legs) {
    const account = getAssociatedTokenAddressSync(
      l.mintKey, user.publicKey, true, l.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const held = await balanceOf(conn, account);
    console.log(`  ${l.key.padEnd(9)} ${(Number(held) / 10 ** l.decimals).toFixed(6)}`);
  }

  if (afterRedeem >= afterMint) throw new Error('redeem did not burn index tokens');
  console.log('\nThe browser path works end to end on a wallet that did not exist five seconds ago.\n');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
