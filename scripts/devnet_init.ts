/**
 * Bring the devnet deployment up: three vaults, seven wrappers, a seeded
 * basket, then unpause.
 *
 *   npx tsx scripts/devnet_init.ts            # plan only, spends nothing
 *   npx tsx scripts/devnet_init.ts --send     # runs it
 *
 * Runs in the order `CLAUDE.md` sets out, and is idempotent at each step: a
 * vault, wrapper or seed already in place is skipped, so a run that dies
 * halfway can simply be repeated.
 *
 * Requires `scripts/devnet_mocks.ts --send` and `scripts/devnet_post_prices.ts
 * --send` to have run, because it needs mints to register and a live price
 * account to read.
 *
 * Seeding happens while the vault is PAUSED, which is the one window where
 * the authority may deposit and the issuer cap does not apply. It has to be
 * skipped there: the first deposit into an empty vault is 100% of one issuer
 * by definition.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { feedFor } from '../config/devnet_feeds.js';
import { MULTIPLIER, SEEDS, feedIdBytes } from './lib/codec.js';
import * as ix from './lib/ix.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

/**
 * Oracle staleness bound on devnet.
 *
 * Mainnet uses the spec §9 default of 60 seconds, which works because Pyth
 * sponsors a continuously refreshed feed. Nobody sponsors devnet, so the
 * price is whatever `devnet_post_prices.ts` last wrote, and a 60 second
 * window would leave every instruction failing a minute after setup. An hour
 * is long enough to demo and short enough that a forgotten deployment still
 * goes stale rather than trading on a week-old price.
 */
const DEVNET_MAX_AGE_SECONDS = 3600;

/** Whole tokens of each wrapper to seed, unless the wrapper names its own. */
const SEED_TOKENS = 10;

type Step = { label: string; ixs: TransactionInstruction[]; signers?: Keypair[] };

async function main() {
  if (CLUSTER !== 'devnet') {
    throw new Error('This script sets up the devnet deployment. Refusing to run on mainnet.');
  }
  banner('Quorum: initialize devnet vaults');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();

  const steps: Step[] = [];
  const skipped: string[] = [];

  for (const v of MOCK_VAULTS) {
    const symbol = v.symbol;
    const vault = SEEDS.vault(symbol);
    const feed = feedFor(symbol);
    const priceUpdate = state.priceUpdates[symbol];
    if (!priceUpdate) {
      throw new Error(`No price account for ${symbol}. Run devnet_post_prices.ts --send first.`);
    }

    const vaultExists = (await conn.getAccountInfo(vault)) !== null;
    if (vaultExists) {
      skipped.push(`${symbol} vault already exists`);
    } else {
      steps.push({
        label: `initialize_vault ${symbol} on ${feed.label}`,
        ixs: [
          ix.initializeVault(kp.publicKey, {
            symbol,
            unit: v.unit,
            underlyingFeedId: feedIdBytes(feed.feedId),
            // Same key for now. Mainnet puts the authority on a multisig and
            // the guardian on a separate hot key (invariant 6).
            guardian: kp.publicKey,
            maxAgeSeconds: DEVNET_MAX_AGE_SECONDS,
            maxConfBps: 100,
            feeMintBps: 10,
            feeRedeemBps: 10,
            marketClosedSurchargeBps: 30,
            navBreakerBps: 800,
            navBreakerWindowSeconds: 600,
          }),
        ],
      });
    }

    const legs = v.wrappers.map((w) => ({ mint: new PublicKey(state.mints[w.key]) }));

    for (const w of v.wrappers) {
      const mintStr = state.mints[w.key];
      if (!mintStr) throw new Error(`No mint recorded for ${w.key}. Run devnet_mocks.ts --send.`);
      const mint = new PublicKey(mintStr);
      const tokenProgram =
        w.multiplierSource === MULTIPLIER.Token2022ScaledUi
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;

      if ((await conn.getAccountInfo(SEEDS.wrapper(vault, mint))) !== null) {
        skipped.push(`${symbol}/${w.key} already registered`);
      } else {
        steps.push({
          label: `register_wrapper ${symbol}/${w.key}`,
          ixs: [
            ix.registerWrapper(kp.publicKey, symbol, mint, tokenProgram, {
              unitsPerToken: w.unitsPerToken,
              multiplierSource: w.multiplierSource,
              targetWeightBps: w.targetWeightBps,
              maxWeightBps: v.maxWeightBps,
              haircutBps: 1000,
            }),
          ],
        });
      }
    }

    // Seeding is one mint_in_kind per leg, each reading NAV across the whole
    // registry, so every leg has to be registered before the first deposit.
    const indexMint = SEEDS.indexMint(vault);
    const userIndexAccount = getAssociatedTokenAddressSync(
      indexMint,
      kp.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    for (const [i, w] of v.wrappers.entries()) {
      const mint = new PublicKey(state.mints[w.key]);
      const tokenProgram =
        w.multiplierSource === MULTIPLIER.Token2022ScaledUi
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
      const vaultTokenAccount = SEEDS.vaultToken(vault, mint);

      const held = await balanceOf(conn, vaultTokenAccount);
      if (held > 0n) {
        skipped.push(`${symbol}/${w.key} already seeded (${held} raw)`);
        continue;
      }

      const userWrapperAccount = getAssociatedTokenAddressSync(
        mint,
        kp.publicKey,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const ixs: TransactionInstruction[] = [];
      if (i === 0) {
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            kp.publicKey,
            userIndexAccount,
            kp.publicKey,
            indexMint,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }
      ixs.push(
        ix.mintInKind({
          user: kp.publicKey,
          symbol,
          mint,
          userWrapperAccount,
          userIndexAccount,
          priceUpdate: new PublicKey(priceUpdate),
          wrapperTokenProgram: tokenProgram,
          legs,
          amount: BigInt(Math.round((w.seedTokens ?? SEED_TOKENS) * 10 ** w.decimals)),
          // Seeding accepts whatever NAV says. A real user passes a real bound.
          minIndexOut: 0n,
        }),
      );
      steps.push({
        label: `seed ${symbol} with ${w.seedTokens ?? SEED_TOKENS} ${w.key}`,
        ixs,
      });
    }

    const vaultAccount = await conn.getAccountInfo(vault);
    // status is the byte after disc(8) bump(1) symbol(12) unit(1); 2 is PAUSED.
    const paused = !vaultAccount || vaultAccount.data[22] === 2;
    if (paused) {
      steps.push({ label: `unpause ${symbol}`, ixs: [ix.unpause(kp.publicKey, symbol)] });
    } else {
      skipped.push(`${symbol} already live`);
    }
  }

  for (const s of skipped) console.log(`  skip  ${s}`);
  if (skipped.length) console.log();
  console.log(`${steps.length} step(s) to run:`);
  for (const [i, s] of steps.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${s.label}`);
  console.log();

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  for (const [i, s] of steps.entries()) {
    const tx = new Transaction().add(...s.ixs);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp, ...(s.signers ?? [])], {
      commitment: 'confirmed',
    });
    console.log(`  ${String(i + 1).padStart(2)}. ${s.label.padEnd(44)} ${sig.slice(0, 16)}...`);
  }
  console.log('\nAll three vaults are live.\n');
}

async function balanceOf(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  if (!info) return 0n;
  return info.data.readBigUInt64LE(64);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
