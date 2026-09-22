/**
 * The depeg check, executing.
 *
 * This path had never run. It compared two Pyth `TwapUpdate` accounts, and
 * no obtainable TWAP exists: the HTTP route returns 404 on full
 * institutional entitlement, and the whole of mainnet holds two such
 * accounts, both years stale. Pyth's answer was to use the exponentially
 * weighted average that already travels inside every price account, so that
 * is what the program reads now, and the defence the design is named for can
 * finally be exercised.
 *
 * The cases below are the ones `CLAUDE.md` requires: under the threshold is
 * rejected, held too briefly is rejected, and a wrapper with no feed cannot
 * be checked at all.
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
  pythAccount, splMint, setAccount, send,
} from './helpers.js';

const SYMBOL = 'qGOLD';
const XAU_FEED = Buffer.alloc(32, 7);
const WRAPPER_FEED = Buffer.alloc(32, 9);
const UNIT_SCALE = 1_000_000_000n;

/** $4,357.05 at exponent -8, the shape the real XAU feed publishes. */
const GOLD = 435_705_000_000n;
const EXPO = -8;

/** Soft 2% held for 10 minutes, hard 5%: the spec §9.1 defaults. */
const SOFT_BPS = 200;
const HARD_BPS = 500;
const MIN_DURATION = 600n;

interface World {
  svm: LiteSVM;
  authority: Keypair;
  now: bigint;
  vault: PublicKey;
  mint: PublicKey;
  wrapperConfig: PublicKey;
  underlyingPrice: PublicKey;
  wrapperPrice: PublicKey;
}

/** A vault with one wrapper that has a price feed of its own. */
function world(opts: { hasWrapperFeed?: boolean } = {}): World {
  const svm = new LiteSVM().withBuiltins().withSysvars().withDefaultPrograms();
  svm.addProgramFromFile(PROGRAM_ID, 'target/deploy/quorum.so');

  const authority = Keypair.generate();
  const guardian = Keypair.generate();
  svm.airdrop(authority.publicKey, 100n * 1_000_000_000n);

  const now = 1_700_000_000n;
  const clock = svm.getClock();
  clock.unixTimestamp = now;
  svm.setClock(clock);

  const vault = SEEDS.vault(SYMBOL);
  const r0 = send(svm, authority, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([
        ixDisc('initialize_vault'), strb(SYMBOL), u8b(1), XAU_FEED,
        guardian.publicKey.toBuffer(),
        u64b(60), u16b(500), u16b(10), u16b(10), u16b(30), u16b(800), i64b(600),
      ]),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: SEEDS.indexMint(vault), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    }),
  ]);
  assert.ok(!isErr(r0), `init failed:\n${logs(r0)}`);

  const mint = Keypair.generate().publicKey;
  setAccount(svm, mint, splMint(6), TOKEN_PROGRAM_ID);
  const hasFeed = opts.hasWrapperFeed ?? true;
  const r1 = send(svm, authority, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      data: Buffer.concat([
        ixDisc('register_wrapper'), u128b(UNIT_SCALE), u8b(0),
        u16b(10_000), u16b(10_000), u16b(0),
        PublicKey.default.toBuffer(),
        hasFeed ? WRAPPER_FEED : Buffer.alloc(32), u8b(hasFeed ? 1 : 0),
        Buffer.alloc(32), u8b(0),
      ]),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SEEDS.wrapper(vault, mint), isSigner: false, isWritable: true },
        { pubkey: SEEDS.vaultToken(vault, mint), isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }),
  ]);
  assert.ok(!isErr(r1), `register failed:\n${logs(r1)}`);

  return {
    svm, authority, now, vault, mint,
    wrapperConfig: SEEDS.wrapper(vault, mint),
    underlyingPrice: Keypair.generate().publicKey,
    wrapperPrice: Keypair.generate().publicKey,
  };
}

/**
 * Publish both sides. `wrapperEma` is what the wrapper's average says one
 * token is worth; fair value is the underlying's average, since this wrapper
 * is one unit per token with no multiplier.
 */
function publish(w: World, wrapperEma: bigint, at = w.now) {
  setAccount(
    w.svm, w.underlyingPrice,
    pythAccount({
      feedId: XAU_FEED, price: GOLD, conf: 1_000_000n, exponent: EXPO,
      publishTime: at, emaPrice: GOLD,
    }),
    new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'),
  );
  setAccount(
    w.svm, w.wrapperPrice,
    pythAccount({
      feedId: WRAPPER_FEED, price: wrapperEma, conf: 1_000_000n, exponent: EXPO,
      publishTime: at, emaPrice: wrapperEma,
    }),
    new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'),
  );
}

/**
 * `check_depeg` takes no arguments, so calling it twice builds the identical
 * transaction and litesvm rejects the repeat as already processed. Expiring
 * the blockhash first is what a real caller gets for free by living in a
 * later slot.
 */
function checkDepeg(w: World) {
  w.svm.expireBlockhash();
  return send(w.svm, w.authority, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      data: ixDisc('check_depeg'),
      keys: [
        { pubkey: w.vault, isSigner: false, isWritable: false },
        { pubkey: w.wrapperConfig, isSigner: false, isWritable: true },
        { pubkey: w.underlyingPrice, isSigner: false, isWritable: false },
        { pubkey: w.mint, isSigner: false, isWritable: false },
        { pubkey: w.wrapperPrice, isSigner: false, isWritable: false },
      ],
    }),
  ]);
}

/**
 * `WrapperConfig.status`, which sits after
 * disc(8) bump(1) vault(32) wrapper_mint(32) vault_token_account(32)
 * decimals(1) is_token_2022(1) units_per_token(16) multiplier_source(1)
 * target_weight_bps(2) max_weight_bps(2).
 */
const STATUS_OFFSET = 8 + 1 + 32 + 32 + 32 + 1 + 1 + 16 + 1 + 2 + 2;

function wrapperStatus(w: World): number {
  return Buffer.from(w.svm.getAccount(w.wrapperConfig)!.data)[STATUS_OFFSET];
}

function isErr(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'err' in (r as Record<string, unknown>);
}
function logs(r: any): string {
  try {
    const m = r.meta?.() ?? r;
    const l = m.logs?.().join('\n');
    if (l) return l;
  } catch { /* fall through */ }
  try { return `err=${JSON.stringify(r.err?.() ?? r.err)} ${String(r)}`; } catch { return String(r); }
}

describe('check_depeg, reading the averaged price', () => {
  it('runs at all, which it could not before', () => {
    const w = world();
    publish(w, GOLD); // trading exactly at fair value
    const r = checkDepeg(w);
    assert.ok(!isErr(r), `check_depeg failed:\n${logs(r)}`);
    assert.equal(wrapperStatus(w), 0, 'a wrapper at fair value must stay ACTIVE');
  });

  it('ignores a deviation under the soft threshold', () => {
    const w = world();
    // 1.5% rich: past nothing.
    publish(w, (GOLD * 10_150n) / 10_000n);
    assert.ok(!isErr(checkDepeg(w)));
    assert.equal(wrapperStatus(w), 0, 'under the threshold must not change status');
  });

  it('starts the clock on a soft depeg but does not act yet', () => {
    const w = world();
    // 3% rich: past soft, but the duration has not elapsed.
    publish(w, (GOLD * 10_300n) / 10_000n);
    assert.ok(!isErr(checkDepeg(w)));
    assert.equal(
      wrapperStatus(w), 0,
      'a soft depeg must be watched for the full duration before it bites',
    );
  });

  it('disables minting once the soft depeg has held long enough', () => {
    const w = world();
    const rich = (GOLD * 10_300n) / 10_000n;
    publish(w, rich);
    assert.ok(!isErr(checkDepeg(w)), 'first observation starts the clock');

    const clock = w.svm.getClock();
    clock.unixTimestamp = w.now + MIN_DURATION + 1n;
    w.svm.setClock(clock);
    publish(w, rich, w.now + MIN_DURATION + 1n);

    const r2 = checkDepeg(w);
    assert.ok(!isErr(r2), `second check failed:\n${logs(r2)}`);
    assert.equal(wrapperStatus(w), 1, 'held past the duration must reach MINT_DISABLED');
  });

  it('quarantines immediately on a hard depeg', () => {
    const w = world();
    // 7% cheap: past hard, which needs no duration at all.
    publish(w, (GOLD * 9_300n) / 10_000n);
    const rh = checkDepeg(w);
    assert.ok(!isErr(rh), `hard depeg check failed:\n${logs(rh)}`);
    assert.equal(wrapperStatus(w), 2, 'a hard depeg must quarantine on sight');
  });

  it('refuses a wrapper that has no price feed', () => {
    const w = world({ hasWrapperFeed: false });
    publish(w, GOLD);
    const r = checkDepeg(w);
    assert.ok(isErr(r), 'a wrapper with no feed cannot be depeg-checked');
    assert.match(logs(r), /NoWrapperPriceSource/);
  });

  it('refuses a stale price', () => {
    const w = world();
    // Published well outside the vault's 60 second window.
    publish(w, GOLD, w.now - 3_600n);
    const r = checkDepeg(w);
    assert.ok(isErr(r), 'a stale average must not be acted on');
    assert.match(logs(r), /OracleStale/);
  });
});
