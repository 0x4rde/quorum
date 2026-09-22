/**
 * Arm the depeg defence: register each wrapper's price feed, its redemption
 * rate feed, and align the mock multipliers with what Pyth publishes.
 *
 *   npx tsx scripts/devnet_arm_depeg.ts            # plan only
 *   npx tsx scripts/devnet_arm_depeg.ts --send
 *
 * Three things have to line up before `check_depeg` can run:
 *
 * The wrapper has to name a feed. Using the real token's feed is the
 * faithful choice, since a mock standing in for PAXG should be judged
 * depegged exactly when PAXG is. Three issuers publish none, and those
 * wrappers simply cannot be checked on chain.
 *
 * The mint's multiplier has to agree with Pyth's redemption rate. Our mocks
 * were created with numbers picked by hand, and `verify_redemption_rate`
 * quarantines a mint that disagrees by more than 50bps. mSPYx was set to
 * 1.013 against a real rate of about 1.0057, which is 72bps out: the guard
 * would have been right to quarantine it. Setting the mint to the published
 * rate is not hiding that, it is making the fixture honest so the guard is
 * testing the thing it exists to test.
 *
 * And a price has to be on chain for every feed involved, posted here since
 * devnet sponsors almost none of them.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createUpdateMultiplierDataInstruction,
} from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, PROGRAM_ID, SEEDS, feedIdBytes, ixDisc, u8b } from './lib/codec.js';
import {
  CLUSTER,
  QUORUM_SHARD,
  banner,
  connection,
  fetchPriceUpdates,
  hermes,
  loadDevnetState,
  payer,
  WILL_SPEND,
} from './lib/env.js';
import { TransactionInstruction } from '@solana/web3.js';

/** How close the mint's multiplier must sit to Pyth's rate. */
const MAX_DIVERGENCE_BPS = 50;

/**
 * `WrapperConfigUpdate`: nine optional fields. Only the four that arm the
 * depeg and redemption-rate checks are set; the rest are a zero byte each.
 */
function updateWrapperConfig(
  authority: PublicKey,
  symbol: string,
  mint: PublicKey,
  wrapperFeedId: string | undefined,
  rrFeedId: string | undefined,
): TransactionInstruction {
  const none = u8b(0);
  const some = (bytes: Buffer) => Buffer.concat([u8b(1), bytes]);
  const vault = SEEDS.vault(symbol);

  const data = Buffer.concat([
    ixDisc('update_wrapper_config'),
    none, // units_per_token
    none, // target_weight_bps
    none, // max_weight_bps
    none, // haircut_bps
    none, // dex_price_source
    wrapperFeedId ? some(feedIdBytes(wrapperFeedId)) : none,
    wrapperFeedId ? Buffer.concat([u8b(1), u8b(1)]) : none, // has_wrapper_feed
    rrFeedId ? some(feedIdBytes(rrFeedId)) : none,
    rrFeedId ? Buffer.concat([u8b(1), u8b(1)]) : none, // has_rr_feed
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      // `guardian: Option<Signer>`. Anchor spells None as the program's own
      // id in that slot rather than as an absent account, so omitting it
      // shifts everything after it up by one and the vault gets read as the
      // guardian. Only a units_per_token move over 1% needs the co-signer,
      // and this changes no such thing.
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: SEEDS.wrapper(vault, mint), isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** The live value of a feed, from Hermes. */
async function liveRate(feedId: string): Promise<number> {
  const { url, key } = hermes();
  const res = await fetch(
    `${url}/v2/updates/price/latest?ids[]=${feedId.replace(/^0x/, '')}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Hermes ${res.status} for ${feedId}`);
  const body = (await res.json()) as { parsed: { price: { price: string; expo: number } }[] };
  const p = body.parsed[0].price;
  return Number(p.price) * 10 ** p.expo;
}

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner('Quorum: arm the depeg defence');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();

  const wrappers = MOCK_VAULTS.filter((v) => v.listed !== false).flatMap((v) =>
    v.wrappers.map((w) => ({ ...w, symbol: v.symbol })),
  );

  const configIxs: { label: string; ix: TransactionInstruction }[] = [];
  const multiplierIxs: { label: string; ix: TransactionInstruction }[] = [];
  const feedIds = new Set<string>();

  for (const w of wrappers) {
    const mint = new PublicKey(state.mints[w.key]);

    if (!w.wrapperFeedId) {
      console.log(`  ${w.key.padEnd(10)} no feed published; cannot be depeg-checked`);
      continue;
    }
    feedIds.add(w.wrapperFeedId);
    console.log(`  ${w.key.padEnd(10)} feed armed${w.rrFeedId ? ', redemption rate too' : ''}`);
    configIxs.push({
      label: w.key,
      ix: updateWrapperConfig(kp.publicKey, w.symbol, mint, w.wrapperFeedId, w.rrFeedId),
    });

    if (!w.rrFeedId) continue;
    feedIds.add(w.rrFeedId);

    // Align the mock's multiplier with the published rate.
    if (w.multiplierSource !== MULTIPLIER.Token2022ScaledUi) continue;
    const rate = await liveRate(w.rrFeedId);
    const mockRate = w.initialMultiplier ?? 1;
    const offBps = Math.abs(mockRate / rate - 1) * 10_000;
    if (offBps <= MAX_DIVERGENCE_BPS) {
      console.log(`             multiplier ${mockRate} is ${offBps.toFixed(1)}bps off, within tolerance`);
      continue;
    }
    console.log(
      `             multiplier ${mockRate} is ${offBps.toFixed(1)}bps off Pyth's ${rate.toFixed(8)};` +
        ' setting the mint to the published rate',
    );
    multiplierIxs.push({
      label: w.key,
      ix: createUpdateMultiplierDataInstruction(
        mint,
        kp.publicKey,
        rate,
        // Effective immediately, which is what a devnet fixture wants.
        BigInt(Math.floor(Date.now() / 1000)),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    });
  }

  console.log();
  console.log(`${configIxs.length} wrapper config update(s), ${multiplierIxs.length} multiplier change(s)`);
  console.log(`${feedIds.size} feed(s) need a price posted on chain`);
  console.log();

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  for (const m of multiplierIxs) {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(m.ix), [kp], {
      commitment: 'confirmed',
    });
    console.log(`  ${m.label.padEnd(10)} multiplier  ${sig.slice(0, 16)}...`);
  }
  for (const c of configIxs) {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(c.ix), [kp], {
      commitment: 'confirmed',
    });
    console.log(`  ${c.label.padEnd(10)} config      ${sig.slice(0, 16)}...`);
  }

  // --- the prices those feeds need ---
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: new Wallet(kp) });
  const ids = [...feedIds];
  const vaas = await fetchPriceUpdates(ids);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(vaas, QUORUM_SHARD);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 });
  const sigs = await receiver.provider.sendAll(txs);
  console.log(`\n  posted ${ids.length} price(s) in ${sigs.length} transaction(s)`);

  state.wrapperPrices = Object.fromEntries(
    ids.map((id) => [id, receiver.getPriceFeedAccountAddress(QUORUM_SHARD, id).toBase58()]),
  );
  const { writeFileSync } = await import('node:fs');
  const { DEVNET_STATE } = await import('./lib/env.js');
  writeFileSync(DEVNET_STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`  recorded in ${DEVNET_STATE}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
