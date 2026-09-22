/**
 * Exercise every live path of the devnet deployment, end to end.
 *
 *   npx tsx scripts/devnet_demo.ts            # plan only, spends nothing
 *   npx tsx scripts/devnet_demo.ts --send     # runs it
 *
 * What it covers, in order:
 *
 *   1. update_nav on all three vaults, so NAV is read from a real Pyth
 *      account rather than asserted.
 *   2. mint_in_kind, then redeem_in_kind, on qGOLD. A round trip returns the
 *      deposit minus the two 0.10% fees.
 *   3. The permissionless rebalance: a deliberate overweight, then
 *      begin_rebalance, a fill at a stand-in venue, and end_swap, all in one
 *      transaction.
 *
 * What it does not cover, and cannot on devnet:
 *
 *   - The depeg paths (`check_depeg`, `verify_redemption_rate`), which have
 *     their own script: `npm run devnet:depeg`.
 *   - Real issuer behaviour: a freeze, a permanent-delegate clawback, a
 *     dividend. A mock mint does none of these on its own.
 *
 * The venue is a stand-in, exactly as in `tests/permissionless_swap.test.ts`:
 * the caller sends the borrowed tokens to a sink account and pays the
 * proceeds from its own balance. That is not a simplification of the design,
 * it is the design. The program lends, checks the result, and never learns
 * where the trade happened, so a token transfer and a five-hop Jupiter route
 * are indistinguishable to it.
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
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, SEEDS } from './lib/codec.js';
import * as ix from './lib/ix.js';
import { CLUSTER, banner, connection, loadDevnetState, payer, WILL_SPEND } from './lib/env.js';

/**
 * `rebalance_drift_bps`, the spec §4 default: a leg has to be this far over
 * its target before anyone may rotate out of it.
 */
const DRIFT_TRIGGER_PP = 5;

/** How much of the overweight leg to rotate out, in whole tokens. */
const REBALANCE_TOKENS = 1;

/**
 * A step's instructions are built when the step runs, not when the plan is
 * printed. The overweight deposit has to be sized against the basket as it
 * is at that moment, and the two steps before it both move the basket. A
 * fixed amount works once and then fails the issuer cap, which is the guard
 * working correctly rather than a bug to route around.
 */
type Step = { label: string; build: () => Promise<TransactionInstruction[]> };

const step = (label: string, ixs: TransactionInstruction[]): Step => ({
  label,
  build: async () => ixs,
});

const tokenProgramFor = (m: number) =>
  m === MULTIPLIER.Token2022ScaledUi ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

async function main() {
  if (CLUSTER !== 'devnet') {
    throw new Error('This demo spends tokens and moves vault balances. Devnet only.');
  }
  banner('Quorum: devnet end-to-end demo');

  const conn = connection();
  const kp = payer();
  const state = loadDevnetState<DevnetState>();
  const steps: Step[] = [];

  const resolve = (v: (typeof MOCK_VAULTS)[number]) => {
    const vault = SEEDS.vault(v.symbol);
    return {
      vault,
      indexMint: SEEDS.indexMint(vault),
      priceUpdate: new PublicKey(state.priceUpdates[v.symbol]),
      legs: v.wrappers.map((w) => {
        const mint = new PublicKey(state.mints[w.key]);
        const tokenProgram = tokenProgramFor(w.multiplierSource);
        return {
          ...w,
          mint,
          tokenProgram,
          userAccount: getAssociatedTokenAddressSync(
            mint,
            kp.publicKey,
            false,
            tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        };
      }),
    };
  };

  // --- 1. NAV on every vault ------------------------------------------------
  for (const v of MOCK_VAULTS) {
    const r = resolve(v);
    steps.push(
      step(`update_nav ${v.symbol}`, [
        ix.updateNav({ symbol: v.symbol, priceUpdate: r.priceUpdate, legs: r.legs }),
      ]),
    );
  }

  // --- 2. Mint and redeem on qGOLD -----------------------------------------
  const gold = MOCK_VAULTS.find((v) => v.symbol === 'qGOLD')!;
  const g = resolve(gold);
  const userIndexAccount = getAssociatedTokenAddressSync(
    g.indexMint,
    kp.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const leg0 = g.legs[0];
  const leg1 = g.legs[1];

  steps.push(
    step(`mint_in_kind qGOLD, 1 ${leg0.key}`, [
      ix.mintInKind({
        user: kp.publicKey,
        symbol: gold.symbol,
        mint: leg0.mint,
        userWrapperAccount: leg0.userAccount,
        userIndexAccount,
        priceUpdate: g.priceUpdate,
        wrapperTokenProgram: leg0.tokenProgram,
        legs: g.legs,
        amount: 10n ** BigInt(leg0.decimals),
        minIndexOut: 0n,
      }),
    ]),
  );

  // Redeem returns a slice of every leg, so the user needs an account for
  // each one. They exist already, since the deployer minted all of them.
  steps.push(
    step('redeem_in_kind qGOLD, half the index tokens just minted', [
      ix.redeemInKind({
        user: kp.publicKey,
        symbol: gold.symbol,
        userIndexAccount,
        legs: g.legs.map((l) => ({ mint: l.mint, userAccount: l.userAccount })),
        tokenProgram: TOKEN_PROGRAM_ID,
        // Index tokens carry INDEX_DECIMALS (9). Half of roughly one unit.
        indexAmount: 500_000_000n,
      }),
    ]),
  );

  // --- 3. Permissionless rebalance -----------------------------------------
  steps.push({
    label: `push ${leg0.key} over the ${DRIFT_TRIGGER_PP}pp drift trigger`,
    build: async () => {
      const amount = await overweightDeposit(conn, g.vault, g.legs, leg0, gold.maxWeightBps);
      return [
        ix.mintInKind({
          user: kp.publicKey,
          symbol: gold.symbol,
          mint: leg0.mint,
          userWrapperAccount: leg0.userAccount,
          userIndexAccount,
          priceUpdate: g.priceUpdate,
          wrapperTokenProgram: leg0.tokenProgram,
          legs: g.legs,
          amount,
          minIndexOut: 0n,
        }),
      ];
    },
  });

  // The sink stands in for the venue's side of the trade: somewhere the
  // borrowed tokens go that is not the vault.
  const sink = Keypair.generate();
  const sinkAccount = getAssociatedTokenAddressSync(
    leg0.mint,
    sink.publicKey,
    false,
    leg0.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const lend = BigInt(REBALANCE_TOKENS) * 10n ** BigInt(leg0.decimals);
  // Repay the same number of units in the destination wrapper. Both legs are
  // one ounce per token, so par is a clean fill; `max_loss_bps` would allow
  // 25bp worse.
  const repay = BigInt(REBALANCE_TOKENS) * 10n ** BigInt(leg1.decimals);

  steps.push(
    step(`begin_rebalance + fill + end_swap: ${REBALANCE_TOKENS} ${leg0.key} into ${leg1.key}`, [
      createAssociatedTokenAccountIdempotentInstruction(
        kp.publicKey,
        sinkAccount,
        sink.publicKey,
        leg0.mint,
        leg0.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      ix.beginSwap({
        which: 'begin_rebalance',
        caller: kp.publicKey,
        symbol: gold.symbol,
        sourceMint: leg0.mint,
        destMint: leg1.mint,
        callerSourceAccount: leg0.userAccount,
        priceUpdate: g.priceUpdate,
        sourceTokenProgram: leg0.tokenProgram,
        legs: g.legs,
        amount: lend,
      }),
      // The venue. The program never sees this instruction.
      createTransferInstruction(leg0.userAccount, sinkAccount, kp.publicKey, lend),
      ix.endSwap({
        caller: kp.publicKey,
        symbol: gold.symbol,
        sourceMint: leg0.mint,
        destMint: leg1.mint,
        callerDestAccount: leg1.userAccount,
        callerIndexAccount: userIndexAccount,
        priceUpdate: g.priceUpdate,
        destTokenProgram: leg1.tokenProgram,
        legs: g.legs,
        amount: repay,
      }),
    ]),
  );

  console.log(`${steps.length} step(s):`);
  for (const [i, s] of steps.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${s.label}`);
  console.log();

  if (!WILL_SPEND) {
    console.log('Dry run. Re-run with --send.\n');
    return;
  }

  for (const [i, s] of steps.entries()) {
    const tx = new Transaction().add(...(await s.build()));
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
    console.log(`  ${String(i + 1).padStart(2)}. ${s.label.padEnd(58)} ${sig.slice(0, 16)}...`);
  }

  console.log('\nFinal qGOLD basket:');
  for (const l of g.legs) {
    const held = await balanceOf(conn, SEEDS.vaultToken(g.vault, l.mint));
    console.log(`  ${l.key.padEnd(9)} ${(Number(held) / 10 ** l.decimals).toFixed(4)} tokens`);
  }
  console.log();
}

/**
 * How much of `leg` to deposit to put it over the drift trigger without
 * breaching the issuer cap.
 *
 * Solving `(u + x) / (T + x) = d` for x gives `x = (dT - u) / (1 - d)`. The
 * target weight `d` sits midway between the trigger and the cap, so the
 * result has room on both sides: far enough over target for
 * `begin_rebalance` to accept it, far enough under the cap for
 * `mint_in_kind` to allow it. Every mock is one unit per token, so token
 * counts stand in for units here; the program itself always converts.
 */
async function overweightDeposit(
  conn: Connection,
  vault: PublicKey,
  legs: { mint: PublicKey; decimals: number; targetWeightBps: number }[],
  leg: { mint: PublicKey; decimals: number; targetWeightBps: number; key: string },
  maxWeightBps: number,
): Promise<bigint> {
  let total = 0;
  let held = 0;
  for (const l of legs) {
    const raw = await balanceOf(conn, SEEDS.vaultToken(vault, l.mint));
    const tokens = Number(raw) / 10 ** l.decimals;
    total += tokens;
    if (l.mint.equals(leg.mint)) held = tokens;
  }

  const floor = leg.targetWeightBps / 100 + DRIFT_TRIGGER_PP;
  const ceiling = maxWeightBps / 100;
  if (floor >= ceiling) {
    throw new Error(
      `${leg.key}: the drift trigger (${floor}%) is at or above the issuer cap ` +
        `(${ceiling}%), so no deposit can be both overweight and legal.`,
    );
  }
  const desired = (floor + ceiling) / 200; // midpoint, as a fraction
  const x = (desired * total - held) / (1 - desired);
  if (x <= 0) {
    throw new Error(`${leg.key} is already at ${((100 * held) / total).toFixed(2)}%, nothing to add.`);
  }
  console.log(
    `      ${leg.key} ${((100 * held) / total).toFixed(2)}% -> ` +
      `${(100 * desired).toFixed(2)}%, depositing ${x.toFixed(6)}`,
  );
  return BigInt(Math.floor(x * 10 ** leg.decimals));
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
