/**
 * Mint and redeem, executing against a fabricated chain.
 *
 * Covers the requirements that need real accounts rather than pure
 * functions: the issuer cap, oracle staleness blocking mint while in-kind
 * redeem stays open, and the round trip end to end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  PublicKey, Keypair, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SEEDS,
  ixDisc, u8b, u16b, u64b, i64b, u128b, strb,
  pythAccount, splMint, scaledUiMint, tokenAccount, setAccount, send,
} from './helpers.js';

const SYMBOL = 'qGOLD';
const XAU_FEED = Buffer.alloc(32, 7);
const UNIT_SCALE = 1_000_000_000n;
const NOW = 1_700_000_000n;
// $4,357.05/oz, exponent -8, the shape of the real Pyth XAU feed.
const PRICE = 435_705_000_000n;
const EXPO = -8;

const isErr = (r: any) => typeof r === 'object' && r !== null && 'err' in r;
const logs = (r: any) => { try { return (r.meta?.() ?? r).logs?.().join('\n') ?? String(r); } catch { return String(r); } };

interface World {
  svm: LiteSVM; authority: Keypair; guardian: Keypair; user: Keypair;
  vault: PublicKey; indexMint: PublicKey; price: PublicKey;
  wrappers: { mint: PublicKey; program: PublicKey; vta: PublicKey; cfg: PublicKey }[];
}

/** A vault with `n` Fixed SPL wrappers, seeded and live unless told otherwise. */
function world(opts: { wrappers?: number; maxWeightBps?: number; publishTime?: bigint } = {}): World {
  const n = opts.wrappers ?? 2;
  const svm = new LiteSVM().withBuiltins().withSysvars().withDefaultPrograms();
  svm.addProgramFromFile(PROGRAM_ID, 'target/deploy/quorum.so');

  const authority = Keypair.generate(), guardian = Keypair.generate(), user = Keypair.generate();
  for (const k of [authority, guardian, user]) svm.airdrop(k.publicKey, 1000n * 1_000_000_000n);

  const clock = svm.getClock(); clock.unixTimestamp = NOW; svm.setClock(clock);

  const price = Keypair.generate().publicKey;
  setAccount(svm, price, pythAccount({
    feedId: XAU_FEED, price: PRICE, conf: 100_000_000n, exponent: EXPO,
    publishTime: opts.publishTime ?? NOW,
  }), new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'));

  const vault = SEEDS.vault(SYMBOL);
  const indexMint = SEEDS.indexMint(vault);

  const initData = Buffer.concat([
    ixDisc('initialize_vault'), strb(SYMBOL), u8b(1), XAU_FEED,
    guardian.publicKey.toBuffer(), u64b(60), u16b(500),
    u16b(10), u16b(10), u16b(30), u16b(800), i64b(600),
  ]);
  const r0 = send(svm, authority, [new TransactionInstruction({
    programId: PROGRAM_ID, data: initData,
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
  for (let i = 0; i < n; i++) {
    const mint = Keypair.generate().publicKey;
    setAccount(svm, mint, splMint(6), TOKEN_PROGRAM_ID);
    const cfg = SEEDS.wrapper(vault, mint);
    const vta = SEEDS.vaultToken(vault, mint);
    const data = Buffer.concat([
      ixDisc('register_wrapper'), u128b(UNIT_SCALE), u8b(0),
      u16b(Math.floor(10000 / n)), u16b(opts.maxWeightBps ?? 6000), u16b(0),
      PublicKey.default.toBuffer(), Buffer.alloc(32), u8b(0),
      Buffer.alloc(32), u8b(0),       // rr_feed_id, has_rr_feed
    ]);
    const r = send(svm, authority, [new TransactionInstruction({
      programId: PROGRAM_ID, data,
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
    assert.ok(!isErr(r), `register wrapper ${i} failed:\n${logs(r)}`);
    wrappers.push({ mint, program: TOKEN_PROGRAM_ID, vta, cfg });
  }

  return { svm, authority, guardian, user, vault, indexMint, price, wrappers };
}

/** NAV triples for every registered wrapper, in registry order. */
const navAccounts = (w: World) =>
  w.wrappers.flatMap((x) => [
    { pubkey: x.cfg, isSigner: false, isWritable: false },
    { pubkey: x.vta, isSigner: false, isWritable: false },
    { pubkey: x.mint, isSigner: false, isWritable: false },
  ]);

/** Give `who` an index-token account and a balance of wrapper `i`. */
function fund(w: World, who: Keypair, i: number, amount: bigint) {
  const userWrapper = Keypair.generate().publicKey;
  setAccount(w.svm, userWrapper, tokenAccount(w.wrappers[i].mint, who.publicKey, amount), TOKEN_PROGRAM_ID);
  const userIndex = Keypair.generate().publicKey;
  setAccount(w.svm, userIndex, tokenAccount(w.indexMint, who.publicKey, 0n), TOKEN_2022_PROGRAM_ID);
  return { userWrapper, userIndex };
}

function mintInKind(
  w: World, who: Keypair, i: number, amount: bigint,
  accts: { userWrapper: PublicKey; userIndex: PublicKey }, minOut = 0n,
) {
  const data = Buffer.concat([ixDisc('mint_in_kind'), u64b(amount), u64b(minOut)]);
  return send(w.svm, who, [new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: who.publicKey, isSigner: true, isWritable: false },
      { pubkey: w.vault, isSigner: false, isWritable: true },
      { pubkey: w.wrappers[i].cfg, isSigner: false, isWritable: false },
      { pubkey: w.wrappers[i].mint, isSigner: false, isWritable: false },
      { pubkey: w.wrappers[i].vta, isSigner: false, isWritable: true },
      { pubkey: accts.userWrapper, isSigner: false, isWritable: true },
      { pubkey: w.indexMint, isSigner: false, isWritable: true },
      { pubkey: accts.userIndex, isSigner: false, isWritable: true },
      { pubkey: w.price, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ...navAccounts(w),
    ],
  })]);
}

function unpause(w: World) {
  return send(w.svm, w.authority, [new TransactionInstruction({
    programId: PROGRAM_ID, data: ixDisc('unpause'),
    keys: [
      { pubkey: w.authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: w.vault, isSigner: false, isWritable: true },
    ],
  })]);
}

function setMarketClosed(w: World, who: Keypair, closed: boolean) {
  return send(w.svm, who, [new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDisc('set_market_closed'), u8b(closed ? 1 : 0)]),
    keys: [
      { pubkey: who.publicKey, isSigner: true, isWritable: false },
      { pubkey: w.vault, isSigner: false, isWritable: true },
    ],
  })]);
}

function setWrapperStatus(w: World, who: Keypair, i: number, status: number) {
  return send(w.svm, who, [new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDisc('set_wrapper_status'), u8b(status)]),
    keys: [
      { pubkey: who.publicKey, isSigner: true, isWritable: false },
      { pubkey: w.vault, isSigner: false, isWritable: false },
      { pubkey: w.wrappers[i].cfg, isSigner: false, isWritable: true },
    ],
  })]);
}

function redeemInKind(w: World, who: Keypair, userIndex: PublicKey, amount: bigint, userWrappers: PublicKey[]) {
  return send(w.svm, who, [new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDisc('redeem_in_kind'), u64b(amount)]),
    keys: [
      { pubkey: who.publicKey, isSigner: true, isWritable: false },
      { pubkey: w.vault, isSigner: false, isWritable: false },
      { pubkey: w.indexMint, isSigner: false, isWritable: true },
      { pubkey: userIndex, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ...w.wrappers.flatMap((x, i) => [
        { pubkey: x.cfg, isSigner: false, isWritable: false },
        { pubkey: x.vta, isSigner: false, isWritable: true },
        { pubkey: x.mint, isSigner: false, isWritable: false },
        { pubkey: userWrappers[i], isSigner: false, isWritable: true },
      ]),
    ],
  })]);
}

const balanceOf = (w: World, acct: PublicKey) =>
  Buffer.from(w.svm.getAccount(acct)!.data).readBigUInt64LE(64);
const supplyOf = (w: World) =>
  Buffer.from(w.svm.getAccount(w.indexMint)!.data).readBigUInt64LE(36);

describe('mint_in_kind', () => {
  it('lets the authority seed a paused vault past the issuer cap', () => {
    const w = world({ wrappers: 2, maxWeightBps: 6000 });
    const a = fund(w, w.authority, 0, 10_000_000n); // 10 tokens, 6dp
    const r = mintInKind(w, w.authority, 0, 10_000_000n, a);
    assert.ok(!isErr(r), `seeding failed:\n${logs(r)}`);

    // First mint bootstraps 1 index token per unit of account.
    assert.equal(balanceOf(w, a.userIndex) > 0n, true, 'no index tokens minted');
    assert.equal(balanceOf(w, w.wrappers[0].vta), 10_000_000n, 'vault did not receive the deposit');
  });

  it('blocks a non-authority from depositing into a paused vault', () => {
    const w = world();
    const u = fund(w, w.user, 0, 10_000_000n);
    const r = mintInKind(w, w.user, 0, 10_000_000n, u);
    assert.ok(isErr(r), 'a stranger must not deposit into a paused vault');
    assert.match(logs(r), /VaultPaused/, logs(r));
  });

  /** An in-kind deposit that would push a wrapper past `max_weight_bps` is
   *  rejected. */
  it('rejects a deposit that breaches the issuer cap', () => {
    const w = world({ wrappers: 2, maxWeightBps: 6000 });
    // Seed both legs evenly while paused, then go live.
    for (const i of [0, 1]) {
      const a = fund(w, w.authority, i, 10_000_000n);
      assert.ok(!isErr(mintInKind(w, w.authority, i, 10_000_000n, a)));
    }
    assert.ok(!isErr(unpause(w)));

    // 50/50 now. Pushing leg 0 to ~75% must fail against a 60% cap.
    const big = fund(w, w.user, 0, 20_000_000n);
    const r = mintInKind(w, w.user, 0, 20_000_000n, big);
    assert.ok(isErr(r), 'deposit past max_weight_bps must be rejected');
    assert.match(logs(r), /IssuerCapExceeded/, logs(r));
  });

  it('allows a deposit that stays inside the cap', () => {
    const w = world({ wrappers: 2, maxWeightBps: 6000 });
    for (const i of [0, 1]) {
      const a = fund(w, w.authority, i, 10_000_000n);
      assert.ok(!isErr(mintInKind(w, w.authority, i, 10_000_000n, a)));
    }
    assert.ok(!isErr(unpause(w)));

    const small = fund(w, w.user, 0, 1_000_000n);
    const r = mintInKind(w, w.user, 0, 1_000_000n, small);
    assert.ok(!isErr(r), `in-cap deposit rejected:\n${logs(r)}`);
    assert.ok(balanceOf(w, small.userIndex) > 0n);
  });

  it('honours min_index_out', () => {
    const w = world({ wrappers: 1 });
    const a = fund(w, w.authority, 0, 10_000_000n);
    const r = mintInKind(w, w.authority, 0, 10_000_000n, a, 10n ** 18n);
    assert.ok(isErr(r), 'an unreachable min_index_out must revert');
    assert.match(logs(r), /SlippageExceeded/, logs(r));
  });
});

describe('oracle health', () => {
  /** A stale or wide oracle blocks the swap paths and leaves in-kind redeem
   *  open. The redeem half is the exit guarantee. */
  it('blocks mint on a stale oracle but leaves in-kind redeem open', () => {
    const w = world({ wrappers: 1 });
    const a = fund(w, w.authority, 0, 10_000_000n);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, 10_000_000n, a)), 'seed failed');
    const held = balanceOf(w, a.userIndex);
    assert.ok(held > 0n);

    // Push the clock past max_age (60s) without republishing the price.
    const clock = w.svm.getClock();
    clock.unixTimestamp = NOW + 3600n;
    w.svm.setClock(clock);

    const more = fund(w, w.authority, 0, 1_000_000n);
    const rm = mintInKind(w, w.authority, 0, 1_000_000n, more);
    assert.ok(isErr(rm), 'mint must be blocked by a stale oracle');
    assert.match(logs(rm), /OracleStale/, logs(rm));

    // ...and redeem still works, because it never reads the oracle at all.
    const rr = send(w.svm, w.authority, [new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([ixDisc('redeem_in_kind'), u64b(held)]),
      keys: [
        { pubkey: w.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: w.vault, isSigner: false, isWritable: false },
        { pubkey: w.indexMint, isSigner: false, isWritable: true },
        { pubkey: a.userIndex, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].vta, isSigner: false, isWritable: true },
        { pubkey: w.wrappers[0].mint, isSigner: false, isWritable: false },
        { pubkey: a.userWrapper, isSigner: false, isWritable: true },
      ],
    })]);
    assert.ok(!isErr(rr), `EXIT GUARANTEE BROKEN: in-kind redeem failed on a stale oracle:\n${logs(rr)}`);
    assert.equal(balanceOf(w, a.userIndex), 0n, 'index tokens not burned');
    assert.ok(balanceOf(w, a.userWrapper) > 0n, 'redeemer got nothing back');
  });

  /** The exit must survive a full pause too, not just a stale price. */
  it('leaves in-kind redeem open while the vault is PAUSED', () => {
    const w = world({ wrappers: 1 });
    const a = fund(w, w.authority, 0, 10_000_000n);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, 10_000_000n, a)));
    const held = balanceOf(w, a.userIndex);

    // Vault is still PAUSED (never unpaused), the emergency-stop state.
    const rr = send(w.svm, w.authority, [new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([ixDisc('redeem_in_kind'), u64b(held / 2n)]),
      keys: [
        { pubkey: w.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: w.vault, isSigner: false, isWritable: false },
        { pubkey: w.indexMint, isSigner: false, isWritable: true },
        { pubkey: a.userIndex, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].vta, isSigner: false, isWritable: true },
        { pubkey: w.wrappers[0].mint, isSigner: false, isWritable: false },
        { pubkey: a.userWrapper, isSigner: false, isWritable: true },
      ],
    })]);
    assert.ok(!isErr(rr), `EXIT GUARANTEE BROKEN: in-kind redeem failed while PAUSED:\n${logs(rr)}`);
  });
});

describe('round trip', () => {
  /** Mint then redeem returns the deposit minus fees, with no value leak.
   *  Proven end to end, against real token balances. */
  it('returns the deposit minus fees and never more', () => {
    // One wrapper means it is necessarily 100% of the basket, so the cap has
    // to be 100% for this vault to be legal at all. The cap itself is tested
    // separately against a two-wrapper vault.
    const w = world({ wrappers: 1, maxWeightBps: 10_000 });
    // Establish the vault first so the round-tripper is not the only holder.
    const seed = fund(w, w.authority, 0, 100_000_000n);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, 100_000_000n, seed)));
    assert.ok(!isErr(unpause(w)));

    const deposit = 10_000_000n;
    const u = fund(w, w.user, 0, deposit);
    const rm = mintInKind(w, w.user, 0, deposit, u);
    assert.ok(!isErr(rm), `user mint failed:\n${logs(rm)}`);
    const got = balanceOf(w, u.userIndex);
    assert.ok(got > 0n);
    assert.equal(balanceOf(w, u.userWrapper), 0n, 'deposit not fully taken');

    const rr = send(w.svm, w.user, [new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([ixDisc('redeem_in_kind'), u64b(got)]),
      keys: [
        { pubkey: w.user.publicKey, isSigner: true, isWritable: false },
        { pubkey: w.vault, isSigner: false, isWritable: false },
        { pubkey: w.indexMint, isSigner: false, isWritable: true },
        { pubkey: u.userIndex, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].cfg, isSigner: false, isWritable: false },
        { pubkey: w.wrappers[0].vta, isSigner: false, isWritable: true },
        { pubkey: w.wrappers[0].mint, isSigner: false, isWritable: false },
        { pubkey: u.userWrapper, isSigner: false, isWritable: true },
      ],
    })]);
    assert.ok(!isErr(rr), `redeem failed:\n${logs(rr)}`);

    const back = balanceOf(w, u.userWrapper);
    assert.ok(back <= deposit, `LEAK: got back ${back} from a ${deposit} deposit`);
    // Two 10bps fees, less a sliver clawed back as a holder. Allow 0.5%.
    assert.ok(back * 1000n >= deposit * 995n, `lost too much: ${back} of ${deposit}`);
    assert.equal(balanceOf(w, u.userIndex), 0n, 'index tokens not burned');
  });
});

describe('market-closed surcharge', () => {
  /**
   * Spec §10 puts the surcharge on the swap paths. The program has none, so
   * it attaches to the one mint path there is. A deposit while the market is
   * closed must mint strictly fewer index tokens than the same deposit while
   * it is open, by exactly the surcharge.
   */
  it('costs more to mint while the market is closed', () => {
    const open = world({ wrappers: 2, maxWeightBps: 10_000 });
    const s0 = fund(open, open.authority, 0, 100_000_000n);
    assert.ok(!isErr(mintInKind(open, open.authority, 0, 50_000_000n, s0)));
    assert.ok(!isErr(unpause(open)));
    const u1 = fund(open, open.user, 0, 10_000_000n);
    assert.ok(!isErr(mintInKind(open, open.user, 0, 10_000_000n, u1)), 'open mint failed');
    const whenOpen = balanceOf(open, u1.userIndex);

    const shut = world({ wrappers: 2, maxWeightBps: 10_000 });
    const s1 = fund(shut, shut.authority, 0, 100_000_000n);
    assert.ok(!isErr(mintInKind(shut, shut.authority, 0, 50_000_000n, s1)));
    assert.ok(!isErr(unpause(shut)));
    assert.ok(!isErr(setMarketClosed(shut, shut.guardian, true)));
    const u2 = fund(shut, shut.user, 0, 10_000_000n);
    assert.ok(!isErr(mintInKind(shut, shut.user, 0, 10_000_000n, u2)), 'closed mint failed');
    const whenClosed = balanceOf(shut, u2.userIndex);

    assert.ok(whenClosed < whenOpen,
      `closed-market mint must cost more: ${whenClosed} vs ${whenOpen}`);
    // 0.10% vs 0.40%, so the closed mint keeps 99.60/99.90 of the open one.
    const ratio = Number(whenClosed) / Number(whenOpen);
    assert.ok(ratio > 0.996 && ratio < 0.9975, `unexpected surcharge: ratio ${ratio}`);
  });
});

describe('audit fixes', () => {
  /** Audit #3. One frozen leg must not block the exit for everyone. */
  it('redeem skips a Frozen leg instead of reverting', () => {
    const w = world({ wrappers: 2, maxWeightBps: 10_000 });
    const a0 = fund(w, w.authority, 0, 10_000_000n);
    const a1 = fund(w, w.authority, 1, 10_000_000n);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, 10_000_000n, a0)));
    assert.ok(!isErr(mintInKind(w, w.authority, 1, 10_000_000n, a1)));
    const held = balanceOf(w, a0.userIndex) + balanceOf(w, a1.userIndex);

    // Guardian freezes leg 1 (status 3 = Frozen). Restricting, so allowed.
    w.svm.airdrop(w.guardian.publicKey, 1_000_000_000n);
    const rf = setWrapperStatus(w, w.guardian, 1, 3);
    assert.ok(!isErr(rf), `guardian freeze failed:\n${logs(rf)}`);

    // Simulate the issuer actually freezing the vault's ATA for leg 1 by
    // making its balance un-transferable: state byte 108 = 2 (Frozen).
    const vta = w.svm.getAccount(w.wrappers[1].vta)!;
    const d = Buffer.from(vta.data); d.writeUInt8(2, 108);
    setAccount(w.svm, w.wrappers[1].vta, d, TOKEN_PROGRAM_ID, Number(vta.lamports));

    const rr = redeemInKind(w, w.authority, a0.userIndex, balanceOf(w, a0.userIndex),
      [a0.userWrapper, a1.userWrapper]);
    assert.ok(!isErr(rr), `EXIT BLOCKED by a frozen leg:\n${logs(rr)}`);
    assert.ok(balanceOf(w, a0.userWrapper) > 0n, 'healthy leg not paid');
    assert.equal(balanceOf(w, a1.userWrapper), 0n, 'frozen leg must be skipped, not paid');
    void held;
  });

  /**
   * Audit #5. Mint against a haircut NAV, redeem at full weight = free money.
   * Re-audit F2 closed the door from the other side too: a stranger cannot
   * mint at all while a wrapper is impaired.
   */
  it('haircut applies on redeem as well as mint, closing the arbitrage', () => {
    const w = world({ wrappers: 2, maxWeightBps: 10_000 });
    const s0 = fund(w, w.authority, 0, 100_000_000n);
    const s1 = fund(w, w.authority, 1, 100_000_000n);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, 100_000_000n, s0)));
    assert.ok(!isErr(mintInKind(w, w.authority, 1, 100_000_000n, s1)));
    assert.ok(!isErr(unpause(w)));

    // Quarantine leg 1 (status 2). Default haircut is 10%.
    w.svm.airdrop(w.guardian.publicKey, 1_000_000_000n);
    assert.ok(!isErr(setWrapperStatus(w, w.guardian, 1, 2)));

    // Re-audit F2: a stranger may not mint at all while a leg is impaired --
    // that price is a discount someone else paid for.
    const dep = 10_000_000n;
    const attacker = fund(w, w.user, 0, dep);
    const blocked = mintInKind(w, w.user, 0, dep, attacker);
    assert.ok(isErr(blocked), 'mint into an impaired vault must be refused');
    assert.ok(logs(blocked).includes('VaultImpaired'), logs(blocked));

    // The authority may still mint (it has to, to repair the vault), so the
    // haircut-symmetry property is measured on that path instead.
    const u = fund(w, w.authority, 0, dep);
    assert.ok(!isErr(mintInKind(w, w.authority, 0, dep, u)));
    const uw1 = Keypair.generate().publicKey;
    setAccount(w.svm, uw1, tokenAccount(w.wrappers[1].mint, w.authority.publicKey, 0n), TOKEN_PROGRAM_ID);
    const rr = redeemInKind(w, w.authority, u.userIndex, balanceOf(w, u.userIndex), [u.userWrapper, uw1]);
    assert.ok(!isErr(rr), logs(rr));

    // The arbitrage shows up in RAW units: minting against a haircut NAV buys
    // more index per unit, and an un-haircut payout hands that excess back as
    // real tokens. Deposited 10 units; without the fix the depositor gets
    // ~10.5 raw back (5.5 A + 5.0 Q); with it, ~10.0 (5.5 A + 4.5 Q).
    const back0 = balanceOf(w, u.userWrapper);
    const back1 = balanceOf(w, uw1);
    const rawBack = back0 + back1;
    assert.ok(rawBack <= dep,
      `ARBITRAGE: deposited ${dep} raw units, got back ${rawBack} (${back0} A + ${back1} Q)`);
    assert.ok(back1 > 0n && back1 < back0,
      `quarantined leg must be paid, but haircut: got ${back1} Q vs ${back0} A`);
  });
});
