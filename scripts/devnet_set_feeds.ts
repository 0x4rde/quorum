/**
 * Point each devnet vault at the feed `config/devnet_feeds.ts` names.
 *
 *   npx tsx scripts/devnet_set_feeds.ts            # plan only
 *   npx tsx scripts/devnet_set_feeds.ts --send
 *
 * The equity vaults launched reading a substitute, because the Hermes key
 * could not fetch `Equity.US.SPY` or `Equity.US.MSTR`. Pyth granted both on
 * 2026-09-22, so they can read the feed they would read on mainnet. This
 * changes `underlying_feed_id` in place rather than recreating the vaults,
 * which keeps their baskets, their holders and their history.
 *
 * Changing the feed resets the circuit breaker's anchor, by design: the
 * program cannot compare a price in one asset against a reading taken in
 * another, so it re-seeds on the next NAV read rather than reporting a move
 * of several hundred percent.
 *
 * Run `devnet_post_prices.ts --send` afterwards. The new feeds may have no
 * sponsored account on devnet, in which case a price has to be posted before
 * anything that reads one will work.
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { DEVNET_FEEDS } from '../config/devnet_feeds.js';
import type { DevnetState } from '../config/devnet_wrappers.js';
import { PROGRAM_ID, SEEDS, feedIdBytes, ixDisc, u8b } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

/** Offset of `underlying_feed_id` in the Vault account. */
const FEED_OFFSET =
  8 + // discriminator
  1 + // bump
  12 + // symbol
  1 + // unit
  1 + // status
  32 + // authority
  32 + // guardian
  32 + // index_mint
  1; // index_mint_bump

/**
 * `VaultConfigUpdate` with only the first of its eighteen optional fields
 * present: a presence byte and the value, then a zero byte for each of the
 * seventeen left alone.
 */
function updateFeed(authority: PublicKey, symbol: string, feedId: string) {
  const data = Buffer.concat([
    ixDisc('update_vault_config'),
    u8b(1),
    feedIdBytes(feedId),
    ...Array.from({ length: 17 }, () => u8b(0)),
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
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner('Quorum: point each vault at its real feed');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();

  const steps: { symbol: string; ix: TransactionInstruction }[] = [];

  for (const f of DEVNET_FEEDS) {
    const recorded = state.vaults[f.vault];
    if (!recorded) {
      console.log(`  skip  ${f.vault} is not deployed`);
      continue;
    }
    const info = await conn.getAccountInfo(new PublicKey(recorded.vault));
    if (!info) {
      console.log(`  skip  ${f.vault} account missing`);
      continue;
    }
    const current = info.data.subarray(FEED_OFFSET, FEED_OFFSET + 32).toString('hex');
    const wanted = f.feedId.replace(/^0x/, '');

    if (current === wanted) {
      console.log(`  ok    ${f.vault.padEnd(7)} already on ${f.label}`);
      continue;
    }
    console.log(`  set   ${f.vault.padEnd(7)} ${current.slice(0, 12)}… -> ${f.label}`);
    steps.push({ symbol: f.vault, ix: updateFeed(kp.publicKey, f.vault, f.feedId) });
  }

  console.log();
  if (!WILL_SPEND) {
    console.log(`Dry run, ${steps.length} change(s). Re-run with --send.\n`);
    return;
  }

  for (const s of steps) {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(s.ix), [kp], {
      commitment: 'confirmed',
    });
    console.log(`  ${s.symbol.padEnd(7)} ${sig.slice(0, 16)}...`);
  }
  console.log('\nNow run: npm run devnet:prices -- --send\n');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
