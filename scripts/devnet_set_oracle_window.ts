/**
 * Set `max_age_seconds` on the devnet vaults.
 *
 *   npx tsx scripts/devnet_set_oracle_window.ts             # plan only
 *   npx tsx scripts/devnet_set_oracle_window.ts --send
 *   MAX_AGE_SECONDS=3600 npx tsx scripts/devnet_set_oracle_window.ts --send
 *
 * ## Why this is not a guard being weakened
 *
 * `max_age_seconds` exists to stop the vault pricing against a dead feed. On
 * mainnet that bound is meaningful because Pyth sponsors a continuously
 * refreshed account, so a stale reading means something is wrong and the
 * right answer is to refuse.
 *
 * On devnet nothing is sponsored. The price is whatever the operator last
 * posted, and posting requires Hermes, which requires an entitlement on the
 * team key. When that entitlement lapses there is no way to refresh at all,
 * and a tight window then means the whole deployment goes dark rather than
 * failing safe: every read path stops, including ones that would happily
 * have served a slightly older number.
 *
 * So the devnet window is set wide deliberately, and the `/devnet` page shows
 * the real age of every price so nobody mistakes an old reading for a fresh
 * one. Mainnet keeps the spec §9 default of 60 seconds. Never run this with
 * CLUSTER=mainnet; it refuses.
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { PROGRAM_ID, SEEDS, ixDisc, u64b, u8b } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

/** 30 days. Long enough to outlast a lapsed entitlement, not forever. */
const MAX_AGE_SECONDS = Number(process.env.MAX_AGE_SECONDS ?? 30 * 24 * 3600);

/** Offset of `max_age_seconds` in the Vault account. */
const MAX_AGE_OFFSET =
  8 + // discriminator
  1 + // bump
  12 + // symbol
  1 + // unit
  1 + // status
  32 + // authority
  32 + // guardian
  32 + // index_mint
  1 + // index_mint_bump
  32; // underlying_feed_id

/**
 * `VaultConfigUpdate`: eighteen `Option<T>` fields, each one a presence byte
 * followed by the value when present. Only `max_age_seconds`, the second
 * field, is set here; the other seventeen are a single zero byte apiece.
 */
function updateVaultConfig(authority: PublicKey, symbol: string, maxAge: number) {
  const none = u8b(0);
  const data = Buffer.concat([
    ixDisc('update_vault_config'),
    none, // underlying_feed_id
    u8b(1),
    u64b(maxAge), // max_age_seconds
    ...Array.from({ length: 16 }, () => none), // the remaining sixteen
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SEEDS.vault(symbol), isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  if (CLUSTER !== 'devnet') {
    throw new Error('Refusing to widen the oracle window on mainnet.');
  }
  banner('Quorum: set the devnet oracle staleness window');
  const conn = connection();
  const kp = payer();
  loadDevnetState<DevnetState>();

  console.log(`Target max_age_seconds: ${MAX_AGE_SECONDS} (${(MAX_AGE_SECONDS / 86400).toFixed(1)} days)\n`);

  const steps: { label: string; ix: TransactionInstruction }[] = [];
  for (const v of MOCK_VAULTS) {
    const info = await conn.getAccountInfo(SEEDS.vault(v.symbol));
    if (!info) {
      console.log(`  skip  ${v.symbol} not deployed`);
      continue;
    }
    const current = Number(info.data.readBigUInt64LE(MAX_AGE_OFFSET));
    if (current === MAX_AGE_SECONDS) {
      console.log(`  skip  ${v.symbol} already ${current}s`);
      continue;
    }
    console.log(`  set   ${v.symbol} ${current}s -> ${MAX_AGE_SECONDS}s`);
    steps.push({
      label: v.symbol,
      ix: updateVaultConfig(kp.publicKey, v.symbol, MAX_AGE_SECONDS),
    });
  }
  console.log();

  if (!WILL_SPEND) {
    console.log(`Dry run, ${steps.length} update(s). Re-run with --send.\n`);
    return;
  }

  for (const s of steps) {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(s.ix), [kp], {
      commitment: 'confirmed',
    });
    console.log(`  ${s.label.padEnd(7)} ${sig.slice(0, 16)}...`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
