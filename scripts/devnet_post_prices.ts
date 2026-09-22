/**
 * Post Pyth price updates for the vault underlyings, on whichever cluster
 * `CLUSTER` names.
 *
 *   npx tsx scripts/devnet_post_prices.ts            # simulate, spends nothing
 *   npx tsx scripts/devnet_post_prices.ts --send     # writes the accounts
 *
 * Why this exists: Quorum reads the Pyth pull oracle, so a `PriceUpdateV2`
 * account only exists if somebody posted it. On mainnet, Pyth's own sponsored
 * feeds cover the underlyings and nothing here is needed. On devnet nobody
 * sponsors anything, so the operator posts them.
 *
 * The accounts this writes are real: owned by the real Pyth receiver program,
 * carrying a real Wormhole-verified signature over real Hermes data. Nothing
 * about the oracle path is mocked, which is the point. The program is not
 * modified or feature-flagged for devnet.
 *
 * Before posting anything it looks for a sponsored account that Pyth is
 * already keeping fresh. Pyth maintains shard 0 on devnet for the major
 * crypto feeds, updating every couple of minutes, and a sponsored account is
 * strictly better than one of ours: it needs no Hermes access, no operator,
 * and it does not go stale the moment we stop paying attention. Posting is
 * the fallback for feeds nobody sponsors.
 *
 * When it does post, it writes to a price-feed account rather than a one-shot
 * update account, so the address is derived from `[shard, feed_id]` and stays
 * the same every run.
 * That gives the vaults and the frontend a fixed oracle address, and lets a
 * later run refresh the price in place before it goes stale. Pyth maintains
 * shards 0 and 1 on mainnet; devnet has no sponsor, so this claims a shard of
 * its own and the deployer becomes its write authority.
 *
 * Feed entitlement is the constraint. The team's Hermes key covers Metal.XAU
 * and the major crypto feeds but not Equity.US.*, so the equity vaults use a
 * stand-in underlying on devnet. `config/devnet_feeds.ts` says which, and why.
 */
import { Wallet } from '@coral-xyz/anchor';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEVNET_FEEDS } from '../config/devnet_feeds.js';
import type { DevnetState } from '../config/devnet_wrappers.js';
import {
  banner,
  connection,
  DEVNET_STATE,
  fetchPriceUpdates,
  payer,
  QUORUM_SHARD,
  WILL_SPEND,
} from './lib/env.js';
import { Connection, PublicKey } from '@solana/web3.js';

/** Pyth's push oracle. Sponsored feed accounts are PDAs of `[shard, feed_id]`. */
const PUSH_ORACLE = new PublicKey('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
const RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';

/** Shards Pyth itself maintains, in the order worth trying. */
const SPONSORED_SHARDS = [0, 1];

/**
 * How recent a sponsored account has to be before we rely on it instead of
 * posting our own. Pyth refreshes the devnet crypto feeds every couple of
 * minutes; an hour means it is genuinely being maintained rather than left
 * behind at some point in the past.
 */
const SPONSORED_MAX_AGE = 3600;

/**
 * A sponsored account for this feed that Pyth is actively updating, if there
 * is one. Checks the things the program checks, so a match here means the
 * vault will accept it: right owner, Full verification, matching feed id.
 */
async function findSponsored(
  conn: Connection,
  feedId: string,
): Promise<{ address: PublicKey; shard: number; age: number; price: number } | null> {
  const feed = Buffer.from(feedId.replace(/^0x/, ''), 'hex');
  const now = Math.floor(Date.now() / 1000);

  for (const shard of SPONSORED_SHARDS) {
    const s = Buffer.alloc(2);
    s.writeUInt16LE(shard);
    const [address] = PublicKey.findProgramAddressSync([s, feed], PUSH_ORACLE);
    const info = await conn.getAccountInfo(address);
    if (!info || info.owner.toBase58() !== RECEIVER) continue;

    // PriceUpdateV2: disc(8) write_authority(32) verification(1) feed_id(32)
    //                price(i64) conf(u64) exponent(i32) publish_time(i64)
    if (info.data[40] !== 1) continue; // not Full verification
    if (info.data.subarray(41, 73).toString('hex') !== feed.toString('hex')) continue;

    const o = 73;
    const age = now - Number(info.data.readBigInt64LE(o + 20));
    if (age > SPONSORED_MAX_AGE) continue;
    const price = Number(info.data.readBigInt64LE(o)) * 10 ** info.data.readInt32LE(o + 16);
    return { address, shard, age, price };
  }
  return null;
}

async function main() {
  banner('Quorum: post Pyth price updates');

  const conn = connection();
  const kp = payer();
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: new Wallet(kp) });

  const feeds = DEVNET_FEEDS;
  console.log('Feeds to post:');
  for (const f of feeds) {
    console.log(`  ${f.vault.padEnd(7)} ${f.label.padEnd(22)} ${f.feedId}`);
    if (f.standIn) console.log(`          stand-in on devnet: ${f.standIn}`);
  }
  console.log();

  // Prefer what Pyth already maintains.
  const addresses: Record<string, string> = {};
  const needPosting: typeof feeds = [];
  for (const f of feeds) {
    const sponsored = await findSponsored(conn, f.feedId);
    if (sponsored) {
      addresses[f.vault] = sponsored.address.toBase58();
      console.log(
        `  ${f.vault.padEnd(7)} sponsored by Pyth on shard ${sponsored.shard}, ` +
          `$${sponsored.price.toFixed(2)}, ${sponsored.age}s old. Nothing to post.`,
      );
    } else {
      needPosting.push(f);
    }
  }

  if (needPosting.length === 0) {
    console.log('\nEvery feed is sponsored and fresh. No transaction needed.\n');
    record(addresses);
    return;
  }

  console.log(
    `\n${needPosting.length} feed(s) nobody sponsors: ` +
      `${needPosting.map((f) => f.vault).join(', ')}. Posting those.\n`,
  );

  const vaas = await fetchPriceUpdates(needPosting.map((f) => f.feedId));
  console.log(`Hermes returned ${vaas.length} signed update(s).\n`);

  // `closeUpdateAccounts: false` keeps the encoded VAA around long enough for
  // the feed write; the feed account itself is a PDA and persists regardless.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(vaas, QUORUM_SHARD);

  for (const f of needPosting) {
    addresses[f.vault] = receiver
      .getPriceFeedAccountAddress(QUORUM_SHARD, f.feedId)
      .toBase58();
  }

  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
  });

  console.log(`Price feed accounts (shard ${QUORUM_SHARD}):`);
  for (const [vault, addr] of Object.entries(addresses)) {
    console.log(`  ${vault.padEnd(7)} ${addr}`);
  }
  console.log(`\n${txs.length} transaction(s) to submit.\n`);

  if (!WILL_SPEND) {
    for (const [i, t] of txs.entries()) {
      const sim = await conn.simulateTransaction(t.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      const err = sim.value.err;
      console.log(
        `  tx ${i + 1}: ${err ? `FAILED ${JSON.stringify(err)}` : 'ok'}` +
          ` (${sim.value.unitsConsumed ?? '?'} CU)`,
      );
      if (err) console.log((sim.value.logs ?? []).slice(-8).map((l) => `      ${l}`).join('\n'));
    }
    console.log('\nDry run. Re-run with --send to write these accounts.\n');
    return;
  }

  const sigs = await receiver.provider.sendAll(txs);
  for (const s of sigs) console.log(`  ${s}`);

  record(addresses);
  console.log(
    '\nThese addresses are stable. Re-run before the vault max_age window' +
      ' expires to refresh the price in place.\n',
  );
}

/** Write the chosen price accounts into the devnet deployment record. */
function record(addresses: Record<string, string>) {
  if (!existsSync(DEVNET_STATE)) return;
  const state = JSON.parse(readFileSync(DEVNET_STATE, 'utf8')) as DevnetState;
  state.priceUpdates = { ...state.priceUpdates, ...addresses };
  writeFileSync(DEVNET_STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Recorded in ${DEVNET_STATE}. Run npm run devnet:sync to update the frontend.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
