/**
 * The permissionless swaps, executed end to end.
 *
 * These could not be written while the program routed through Jupiter by CPI,
 * because litesvm has no aggregator to route against. Splitting the path into
 * a loan and a settle makes the middle of the transaction arbitrary, so a test
 * can stand in for the venue with a plain token transfer and drive the whole
 * bound set: the floor, the basket total, the issuer cap, the size cap, the
 * settle-must-exist rule and the one-loan-at-a-time rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  PublicKey, Keypair, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import { createTransferInstruction } from '@solana/spl-token';
import {
  PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SEEDS,
  ixDisc, u8b, u16b, u64b, i64b, u128b, strb,
  pythAccount, splMint, tokenAccount, setAccount, send,
} from './helpers.js';

const SYMBOL = 'qGOLD';
const XAU_FEED = Buffer.alloc(32, 7);
const UNIT_SCALE = 1_000_000_000n;
const NOW = 1_700_000_000n;
const PRICE = 435_705_000_000n;
const EXPO = -8;

const isErr = (r: any) => typeof r === 'object' && r !== null && 'err' in r;
const logs = (r: any) => { try { return (r.meta?.() ?? r).logs?.().join('\n') ?? String(r); } catch { return String(r); } };
const balanceOf = (svm: LiteSVM, acct: PublicKey) =>
  Buffer.from(svm.getAccount(acct)!.data).readBigUInt64LE(64);

interface World {
  svm: LiteSVM; authority: Keypair; caller: Keypair;
  vault: PublicKey; indexMint: PublicKey; price: PublicKey; ticket: PublicKey;
  wrappers: { mint: PublicKey; vta: PublicKey; cfg: PublicKey }[];
  callerSource: PublicKey; callerDest: PublicKey; callerIndex: PublicKey; sink: PublicKey;
}

/**
 * Two SPL wrappers at 6 decimals, seeded 100 / 50 so leg 0 sits at 66.7%
 * against a 50% target. That is 1,667bps of drift against a 500bps trigger,
 * so `begin_rebalance`'s precondition holds.
 */
function world(opts: { maxWeightBps?: number; callerDest?: bigint } = {}): World {
  const svm = new LiteSVM().withBuiltins().withSysvars().withDefaultPrograms();
  svm.addProgramFromFile(PROGRAM_ID, 'target/deploy/quorum.so');

  const authority = Keypair.generate(), guardian = Keypair.generate(), caller = Keypair.generate();
  for (const k of [authority, guardian, caller]) svm.airdrop(k.publicKey, 1000n * 1_000_000_000n);

  const clock = svm.getClock(); clock.unixTimestamp = NOW; svm.setClock(clock);

  const price = Keypair.generate().publicKey;
  setAccount(svm, price, pythAccount({
    feedId: XAU_FEED, price: PRICE, conf: 100_000_000n, exponent: EXPO, publishTime: NOW,
  }), new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'));

  const vault = SEEDS.vault(SYMBOL);
  const indexMint = SEEDS.indexMint(vault);

  const r0 = send(svm, authority, [new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([
      ixDisc('initialize_vault'), strb(SYMBOL), u8b(1), XAU_FEED,
      guardian.publicKey.toBuffer(), u64b(60), u16b(500),
      u16b(10), u16b(10), u16b(30), u16b(800), i64b(600),
    ]),
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: indexMint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
  })]);
  assert.ok(!isErr(r0), `init failed:\n${logs(r0)}`);

  const wrappers = [];
  for (let i = 0; i < 2; i++) {
    const mint = Keypair.generate().publicKey;
    setAccount(svm, mint, splMint(6), TOKEN_PROGRAM_ID);
    const cfg = SEEDS.wrapper(vault, mint);
    const vta = SEEDS.vaultToken(vault, mint);
    const r = send(svm, authority, [new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([
        ixDisc('register_wrapper'), u128b(UNIT_SCALE), u8b(0),
        u16b(5000), u16b(opts.maxWeightBps ?? 10000), u16b(0),
        PublicKey.default.toBuffer(), Buffer.alloc(32), u8b(0),
        Buffer.alloc(32), u8b(0),
      ]),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: cfg, isSigner: false, isWritable: true },
        { pubkey: vta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    })]);
    assert.ok(!isErr(r), `register ${i} failed:\n${logs(r)}`);
    wrappers.push({ mint, vta, cfg });
  }

  // Seed the basket directly. The mint path has its own tests; this one is
  // about what the swaps do to balances.
  setAccount(svm, wrappers[0].vta, tokenAccount(wrappers[0].mint, vault, 100_000_000n), TOKEN_PROGRAM_ID);
  setAccount(svm, wrappers[1].vta, tokenAccount(wrappers[1].mint, vault, 50_000_000n), TOKEN_PROGRAM_ID);

  // Supply has to be non-zero or nav_per_token is zero and the reward maths
  // is skipped. 150 index tokens against 150 units.
  const mintData = Buffer.from(svm.getAccount(indexMint)!.data);
  mintData.writeBigUInt64LE(150_000_000_000n, 36);
  setAccount(svm, indexMint, mintData, TOKEN_2022_PROGRAM_ID);

  const mk = (mint: PublicKey, amount: bigint, program = TOKEN_PROGRAM_ID) => {
    const k = Keypair.generate().publicKey;
    setAccount(svm, k, tokenAccount(mint, caller.publicKey, amount), program);
    return k;
  };
  const callerSource = mk(wrappers[0].mint, 0n);
  const callerDest = mk(wrappers[1].mint, opts.callerDest ?? 50_000_000n);
  const sink = mk(wrappers[0].mint, 0n);
  const callerIndex = mk(indexMint, 0n, TOKEN_2022_PROGRAM_ID);

  const r1 = send(svm, authority, [new TransactionInstruction({
    programId: PROGRAM_ID, data: ixDisc('unpause'),
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
    ],
  })]);
  assert.ok(!isErr(r1), `unpause failed:\n${logs(r1)}`);

  return {
    svm, authority, caller, vault, indexMint, price,
    ticket: SEEDS.swapTicket(vault), wrappers,
    callerSource, callerDest, callerIndex, sink,
  };
}

const navAccounts = (w: World, writable = false) =>
  w.wrappers.flatMap((x) => [
    { pubkey: x.cfg, isSigner: false, isWritable: false },
    { pubkey: x.vta, isSigner: false, isWritable: writable },
    { pubkey: x.mint, isSigner: false, isWritable: false },
  ]);

/** `begin_rebalance`: borrow `amount` of leg 0 against leg 1. */
const beginRebalance = (w: World, amount: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([ixDisc('begin_rebalance'), u64b(amount)]),
  keys: [
    { pubkey: w.caller.publicKey, isSigner: true, isWritable: true },
    { pubkey: w.vault, isSigner: false, isWritable: true },
    { pubkey: w.ticket, isSigner: false, isWritable: true },
    { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: false },
    { pubkey: w.wrappers[1].cfg, isSigner: false, isWritable: false },
    { pubkey: w.wrappers[0].vta, isSigner: false, isWritable: true },
    { pubkey: w.callerSource, isSigner: false, isWritable: true },
    { pubkey: w.wrappers[0].mint, isSigner: false, isWritable: false },
    { pubkey: w.indexMint, isSigner: false, isWritable: false },
    { pubkey: w.price, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...navAccounts(w, true),
  ],
});

/** `end_swap`: pay `amount` of leg 1 back in. */
const endSwap = (w: World, amount: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID,
  data: Buffer.concat([ixDisc('end_swap'), u64b(amount)]),
  keys: [
    { pubkey: w.caller.publicKey, isSigner: true, isWritable: true },
    { pubkey: w.vault, isSigner: false, isWritable: true },
    { pubkey: w.ticket, isSigner: false, isWritable: true },
    { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: true },
    { pubkey: w.wrappers[1].cfg, isSigner: false, isWritable: false },
    { pubkey: w.wrappers[0].vta, isSigner: false, isWritable: false },
    { pubkey: w.wrappers[1].vta, isSigner: false, isWritable: true },
    { pubkey: w.callerDest, isSigner: false, isWritable: true },
    { pubkey: w.wrappers[1].mint, isSigner: false, isWritable: false },
    { pubkey: w.indexMint, isSigner: false, isWritable: true },
    { pubkey: w.callerIndex, isSigner: false, isWritable: true },
    { pubkey: w.price, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...navAccounts(w, true),
  ],
});

/**
 * Stand-in for the venue: the caller spends the borrowed tokens somewhere.
 * The program never sees this instruction, which is the point.
 */
const fakeVenue = (w: World, amount: bigint) =>
  createTransferInstruction(w.callerSource, w.sink, w.caller.publicKey, amount);

describe('permissionless swap, loan and settle', () => {
  it('lends, lets the caller fill anywhere, and takes the proceeds back', () => {
    const w = world();
    const lend = 10_000_000n;  // 10 tokens, the 10% cap on a 100 token leg
    const repay = 10_000_000n; // filled at par

    const r = send(w.svm, w.caller, [
      beginRebalance(w, lend),
      fakeVenue(w, lend),
      endSwap(w, repay),
    ], [w.caller]);
    assert.ok(!isErr(r), `round trip failed:\n${logs(r)}`);

    assert.equal(balanceOf(w.svm, w.wrappers[0].vta), 90_000_000n, 'source leg did not fall by the loan');
    assert.equal(balanceOf(w.svm, w.wrappers[1].vta), 60_000_000n, 'destination leg did not receive the fill');
    assert.equal(balanceOf(w.svm, w.sink), lend, 'the venue never saw the borrowed tokens');
    assert.equal(w.svm.getAccount(w.ticket), null, 'ticket was not closed');
  });

  it('accepts a fill at the very edge of max_loss_bps', () => {
    const w = world();
    // 25bp of 10 tokens is 25,000 raw. One unit less than the floor is the
    // failing case below; the floor itself must pass.
    const r = send(w.svm, w.caller, [
      beginRebalance(w, 10_000_000n), fakeVenue(w, 10_000_000n), endSwap(w, 9_975_000n),
    ], [w.caller]);
    assert.ok(!isErr(r), `a fill exactly at the bound must pass:\n${logs(r)}`);
  });

  it('rejects a fill one unit below the floor', () => {
    const w = world();
    const r = send(w.svm, w.caller, [
      beginRebalance(w, 10_000_000n), fakeVenue(w, 10_000_000n), endSwap(w, 9_974_999n),
    ], [w.caller]);
    assert.ok(isErr(r), 'a fill below max_loss_bps must revert');
    assert.match(logs(r), /UnitsBoundViolated/, logs(r));
  });

  it('refuses to lend when no settle follows in the transaction', () => {
    const w = world();
    const r = send(w.svm, w.caller, [beginRebalance(w, 10_000_000n)], [w.caller]);
    assert.ok(isErr(r), 'a loan with no settle must not commit');
    assert.match(logs(r), /MissingSettleInstruction/, logs(r));
    assert.equal(balanceOf(w.svm, w.wrappers[0].vta), 100_000_000n, 'the vault lent anyway');
  });

  it('refuses a settle that only appears before the loan', () => {
    const w = world();
    const r = send(w.svm, w.caller, [
      endSwap(w, 10_000_000n), beginRebalance(w, 10_000_000n),
    ], [w.caller]);
    assert.ok(isErr(r), 'a settle above the loan does not count');
  });

  it('allows only one loan per vault at a time', () => {
    const w = world();
    const r = send(w.svm, w.caller, [
      beginRebalance(w, 5_000_000n),
      beginRebalance(w, 5_000_000n),
      endSwap(w, 10_000_000n),
    ], [w.caller]);
    assert.ok(isErr(r), 'two concurrent loans on one vault must not open');
  });

  it('enforces the size cap against the leg balance', () => {
    const w = world();
    const r = send(w.svm, w.caller, [
      beginRebalance(w, 10_000_001n), fakeVenue(w, 1n), endSwap(w, 11_000_000n),
    ], [w.caller]);
    assert.ok(isErr(r), 'lending more than max_swap_bps must revert');
    assert.match(logs(r), /SwapSizeExceeded/, logs(r));
  });

  it('will not let a caller be paid to concentrate the basket', () => {
    // Cap each issuer at 55%. Leg 1 starts at 33% and the fill would carry it
    // to 40%, which is fine; repaying far more would not be.
    const w = world({ maxWeightBps: 3500, callerDest: 100_000_000n });
    const r = send(w.svm, w.caller, [
      beginRebalance(w, 10_000_000n), fakeVenue(w, 10_000_000n), endSwap(w, 40_000_000n),
    ], [w.caller]);
    assert.ok(isErr(r), 'a fill that breaches max_weight_bps must revert');
    assert.match(logs(r), /DestinationOverCap/, logs(r));
  });

  it('refuses to rebalance a leg that is not over target', () => {
    const w = world();
    // Leg 1 is the under-weight one, so borrowing from it has no drift to fix.
    const flipped = new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([ixDisc('begin_rebalance'), u64b(1_000_000n)]),
      keys: [
        { pubkey: w.caller.publicKey, isSigner: true, isWritable: true },
        { pubkey: w.vault, isSigner: false, isWritable: true },
        { pubkey: w.ticket, isSigner: false, isWritable: true },
        { pubkey: w.wrappers[1].cfg, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[1].vta, isSigner: false, isWritable: true },
        { pubkey: w.callerDest, isSigner: false, isWritable: true },
        { pubkey: w.wrappers[1].mint, isSigner: false, isWritable: false },
        { pubkey: w.indexMint, isSigner: false, isWritable: false },
        { pubkey: w.price, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ...navAccounts(w, true),
      ],
    });
    const r = send(w.svm, w.caller, [flipped, endSwap(w, 1_000_000n)], [w.caller]);
    assert.ok(isErr(r), 'rebalancing an under-weight leg must revert');
    assert.match(logs(r), /RebalanceNotNeeded/, logs(r));
  });
});
