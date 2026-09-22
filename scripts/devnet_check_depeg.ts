/**
 * Run the depeg check and the redemption-rate cross-check on devnet.
 *
 *   npx tsx scripts/devnet_check_depeg.ts            # plan only
 *   npx tsx scripts/devnet_check_depeg.ts --send
 *
 * Both are permissionless: no allowlist, no registration, anyone may call
 * them. They are the two guards the design leans on hardest and, until the
 * averaged price turned out to be inside every price account, neither had
 * ever executed anywhere.
 *
 * `check_depeg` compares a wrapper's averaged price against the underlying's,
 * both from Pyth, and applies the guard table: nothing under the soft
 * threshold, a watch period before minting closes, and immediate quarantine
 * past the hard one.
 *
 * `verify_redemption_rate` compares the mint's own Scaled UI multiplier
 * against Pyth's published redemption rate. That is invariant 5 made
 * enforceable: reading the multiplier correctly is worth nothing if the
 * multiplier itself is a lie.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, PROGRAM_ID, SEEDS, ixDisc } from './lib/codec.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';
import { TransactionInstruction } from '@solana/web3.js';

/** `WrapperStatus`, in declaration order. */
const STATUS = ['ACTIVE', 'MINT_DISABLED', 'QUARANTINED', 'FROZEN'];

/**
 * Offset of `status` in `WrapperConfig`, after disc(8) bump(1) vault(32)
 * wrapper_mint(32) vault_token_account(32) decimals(1) is_token_2022(1)
 * units_per_token(16) multiplier_source(1) target_weight_bps(2)
 * max_weight_bps(2).
 */
const STATUS_OFFSET = 8 + 1 + 32 + 32 + 32 + 1 + 1 + 16 + 1 + 2 + 2;

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

async function main() {
  if (CLUSTER !== 'devnet') throw new Error('Devnet only.');
  banner('Quorum: run the depeg and redemption-rate checks');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();
  const prices = state.wrapperPrices ?? {};

  const jobs: { label: string; kind: string; ix: TransactionInstruction; config: PublicKey }[] = [];

  for (const v of MOCK_VAULTS.filter((x) => x.listed !== false)) {
    const vault = SEEDS.vault(v.symbol);
    const underlying = state.priceUpdates[v.symbol];
    if (!underlying) continue;

    for (const w of v.wrappers) {
      const mint = new PublicKey(state.mints[w.key]);
      const config = SEEDS.wrapper(vault, mint);

      if (w.wrapperFeedId && prices[w.wrapperFeedId]) {
        jobs.push({
          label: `${v.symbol}/${w.key}`,
          kind: 'depeg',
          config,
          ix: new TransactionInstruction({
            programId: PROGRAM_ID,
            data: ixDisc('check_depeg'),
            keys: [
              ro(vault),
              rw(config),
              ro(new PublicKey(underlying)),
              ro(mint),
              ro(new PublicKey(prices[w.wrapperFeedId])),
            ],
          }),
        });
      }

      if (
        w.rrFeedId &&
        prices[w.rrFeedId] &&
        w.multiplierSource === MULTIPLIER.Token2022ScaledUi
      ) {
        jobs.push({
          label: `${v.symbol}/${w.key}`,
          kind: 'rate',
          config,
          ix: new TransactionInstruction({
            programId: PROGRAM_ID,
            data: ixDisc('verify_redemption_rate'),
            keys: [ro(vault), rw(config), ro(mint), ro(new PublicKey(prices[w.rrFeedId]))],
          }),
        });
      }
    }
  }

  console.log(`${jobs.length} check(s) to run:`);
  for (const j of jobs) console.log(`  ${j.kind.padEnd(6)} ${j.label}`);
  console.log();

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  for (const j of jobs) {
    // Neither instruction takes an argument, so two calls build the same
    // transaction. A fresh blockhash is what keeps the second from being
    // rejected as a duplicate.
    const tx = new Transaction().add(j.ix);
    tx.recentBlockhash = (await conn.getLatestBlockhash('finalized')).blockhash;
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      const info = await conn.getAccountInfo(j.config);
      const status = info ? (STATUS[info.data[STATUS_OFFSET]] ?? '?') : '?';
      console.log(`  ${j.kind.padEnd(6)} ${j.label.padEnd(16)} ok, ${status}  ${sig.slice(0, 16)}...`);
    } catch (e) {
      const m = (e as Error).message;
      const named =
        /Error Message: ([^."]+)/.exec(m)?.[1] ??
        /Program log: (AnchorError[^"]+)/.exec(m)?.[1] ??
        /custom program error: (\w+)/.exec(m)?.[0] ??
        m.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ${j.kind.padEnd(6)} ${j.label.padEnd(16)} ${named}`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
