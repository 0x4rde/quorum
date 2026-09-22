/**
 * Integration tests: the program actually executing.
 *
 * The unit tests in `programs/quorum/src/*` prove the arithmetic. These prove
 * the account wiring: PDA seeds, discriminators, CPI signatures, guard
 * ordering: none of which a pure function test can reach.
 *
 * Run: npm test
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import { PublicKey, Keypair, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SEEDS,
  ixDisc, u8b, u16b, u64b, i64b, u128b, strb,
  pythAccount, splMint, scaledUiMint, tokenAccount, setAccount, send,
} from './helpers.js';

const SYMBOL = 'qGOLD';
const XAU_FEED = Buffer.alloc(32, 7);
const UNIT_SCALE = 1_000_000_000n;

// $4,357.05/oz at exponent -8, matching the real Pyth XAU feed shape.
const GOLD_PRICE = 435_705_000_000n;
const GOLD_EXPO = -8;

function ctx() {
  const svm = new LiteSVM().withBuiltins().withSysvars().withDefaultPrograms();
  svm.addProgramFromFile(PROGRAM_ID, 'target/deploy/quorum.so');

  const authority = Keypair.generate();
  const guardian = Keypair.generate();
  const user = Keypair.generate();
  svm.airdrop(authority.publicKey, 100n * 1_000_000_000n);
  svm.airdrop(user.publicKey, 100n * 1_000_000_000n);

  // Clock at a fixed, non-zero time so staleness maths is meaningful.
  const now = 1_700_000_000n;
  const clock = svm.getClock();
  clock.unixTimestamp = now;
  svm.setClock(clock);

  return { svm, authority, guardian, user, now };
}

function initVault(c: ReturnType<typeof ctx>) {
  const vault = SEEDS.vault(SYMBOL);
  const data = Buffer.concat([
    ixDisc('initialize_vault'),
    strb(SYMBOL),
    u8b(1),                 // Unit::Ounce
    XAU_FEED,
    c.guardian.publicKey.toBuffer(),
    u64b(60),               // max_age_seconds
    u16b(500),              // max_conf_bps (generous for tests)
    u16b(10),               // fee_mint_bps
    u16b(10),               // fee_redeem_bps
    u16b(30),               // market_closed_surcharge_bps
    u16b(800),              // nav_breaker_bps
    i64b(600),              // nav_breaker_window_seconds
  ]);
  const keys = [
    { pubkey: c.authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: SEEDS.indexMint(vault), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  return send(c.svm, c.authority, [new TransactionInstruction({ programId: PROGRAM_ID, keys, data })]);
}

function registerWrapper(
  c: ReturnType<typeof ctx>,
  mint: PublicKey,
  tokenProgram: PublicKey,
  opts: { multiplierSource: number; unitsPerToken?: bigint; maxWeightBps?: number },
) {
  const vault = SEEDS.vault(SYMBOL);
  const data = Buffer.concat([
    ixDisc('register_wrapper'),
    u128b(opts.unitsPerToken ?? UNIT_SCALE),
    u8b(opts.multiplierSource),     // 0 Fixed, 1 Token2022ScaledUi, 2 KeeperPushed
    u16b(5000),                     // target_weight_bps
    u16b(opts.maxWeightBps ?? 6000),
    u16b(0),                        // haircut_bps
    PublicKey.default.toBuffer(),   // dex_price_source
    Buffer.alloc(32),               // wrapper_feed_id
    u8b(0),                         // has_wrapper_feed
    Buffer.alloc(32),               // rr_feed_id
    u8b(0),                         // has_rr_feed
  ]);
  const keys = [
    { pubkey: c.authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SEEDS.wrapper(vault, mint), isSigner: false, isWritable: true },
    { pubkey: SEEDS.vaultToken(vault, mint), isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return send(c.svm, c.authority, [new TransactionInstruction({ programId: PROGRAM_ID, keys, data })]);
}

function isErr(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'err' in (r as Record<string, unknown>);
}
function logsOf(r: any): string {
  try { return (r.meta?.() ?? r).logs?.().join('\n') ?? String(r); }
  catch { return String(r); }
}

describe('quorum program', () => {
  it('initializes a vault, PAUSED, with the index mint under the vault PDA', () => {
    const c = ctx();

    const r = initVault(c);
    assert.ok(!isErr(r), `initialize_vault failed:\n${logsOf(r)}`);

    const vault = SEEDS.vault(SYMBOL);
    const acct = c.svm.getAccount(vault);
    assert.ok(acct, 'vault account not created');
    assert.equal(acct!.owner.toBase58(), PROGRAM_ID.toBase58());

    // status is the byte after disc(8) bump(1) symbol(12) unit(1)
    const status = Buffer.from(acct!.data)[8 + 1 + 12 + 1];
    assert.equal(status, 2, 'a fresh vault must open PAUSED, not live');
  });

  it('registers a Fixed wrapper and opens its PDA-owned token account', () => {
    const c = ctx();
    initVault(c);

    const paxg = Keypair.generate().publicKey;
    setAccount(c.svm, paxg, splMint(6), TOKEN_PROGRAM_ID);

    const r = registerWrapper(c, paxg, TOKEN_PROGRAM_ID, { multiplierSource: 0 });
    assert.ok(!isErr(r), `register_wrapper failed:\n${logsOf(r)}`);

    const vault = SEEDS.vault(SYMBOL);
    assert.ok(c.svm.getAccount(SEEDS.wrapper(vault, paxg)), 'wrapper config missing');
    const vta = c.svm.getAccount(SEEDS.vaultToken(vault, paxg));
    assert.ok(vta, 'vault token account missing');
    assert.equal(vta!.owner.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  });

  /**
   * Invariant 5 (`README.md`) at the account level. `register_wrapper` must
   * refuse a mint
   * whose extension set contradicts the declared multiplier source, this is
   * the check that caught the spec being wrong about Ondo.
   */
  it('refuses a Scaled-UI mint declared as Fixed', () => {
    const c = ctx();
    initVault(c);

    const ondoLike = Keypair.generate().publicKey;
    setAccount(c.svm, ondoLike, scaledUiMint(9, 1.0017152488), TOKEN_2022_PROGRAM_ID);

    const r = registerWrapper(c, ondoLike, TOKEN_2022_PROGRAM_ID, { multiplierSource: 0 });
    assert.ok(isErr(r), 'a Scaled-UI mint registered as FIXED must be rejected');
    assert.match(logsOf(r), /ScaledUiConfigMismatch/, `wrong error:\n${logsOf(r)}`);
  });

  it('refuses a plain mint declared as Scaled UI', () => {
    const c = ctx();
    initVault(c);

    const plain = Keypair.generate().publicKey;
    setAccount(c.svm, plain, splMint(6), TOKEN_PROGRAM_ID);

    const r = registerWrapper(c, plain, TOKEN_PROGRAM_ID, { multiplierSource: 1 });
    assert.ok(isErr(r), 'a plain mint registered as Scaled UI must be rejected');
    assert.match(logsOf(r), /ScaledUiExtensionMissing/, `wrong error:\n${logsOf(r)}`);
  });

  it('accepts a Scaled-UI mint declared correctly', () => {
    const c = ctx();
    initVault(c);

    const xstock = Keypair.generate().publicKey;
    setAccount(c.svm, xstock, scaledUiMint(8, 1.0009180758), TOKEN_2022_PROGRAM_ID);

    const r = registerWrapper(c, xstock, TOKEN_2022_PROGRAM_ID, { multiplierSource: 1 });
    assert.ok(!isErr(r), `correctly-declared Scaled UI wrapper rejected:\n${logsOf(r)}`);
  });

  /**
   * Invariant 6 (`README.md`). The guardian's whole vocabulary is "stop" and
   * "quarantine";
   * loosening anything must require the authority.
   */
  describe('guardian can only restrict', () => {
    function setup() {
      const c = ctx();
      const quote = Keypair.generate().publicKey;
      setAccount(c.svm, quote, splMint(6), TOKEN_PROGRAM_ID);
      initVault(c);
      return c;
    }
    const vault = () => SEEDS.vault(SYMBOL);

    it('guardian may pause', () => {
      const c = setup();
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: c.guardian.publicKey, isSigner: true, isWritable: false },
          { pubkey: vault(), isSigner: false, isWritable: true },
        ],
        data: ixDisc('pause'),
      });
      c.svm.airdrop(c.guardian.publicKey, 1_000_000_000n);
      const r = send(c.svm, c.guardian, [ix]);
      assert.ok(!isErr(r), `guardian pause failed:\n${logsOf(r)}`);
    });

    it('guardian may NOT unpause', () => {
      const c = setup();
      c.svm.airdrop(c.guardian.publicKey, 1_000_000_000n);
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: c.guardian.publicKey, isSigner: true, isWritable: false },
          { pubkey: vault(), isSigner: false, isWritable: true },
        ],
        data: ixDisc('unpause'),
      });
      const r = send(c.svm, c.guardian, [ix]);
      assert.ok(isErr(r), 'guardian must not be able to unpause');
      assert.match(logsOf(r), /NotAuthority|ConstraintRaw/, `wrong error:\n${logsOf(r)}`);
    });

    it('authority may unpause', () => {
      const c = setup();
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: c.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: vault(), isSigner: false, isWritable: true },
        ],
        data: ixDisc('unpause'),
      });
      const r = send(c.svm, c.authority, [ix]);
      assert.ok(!isErr(r), `authority unpause failed:\n${logsOf(r)}`);
    });

    it('a stranger may neither pause nor unpause', () => {
      const c = setup();
      for (const name of ['pause', 'unpause']) {
        const ix = new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: c.user.publicKey, isSigner: true, isWritable: false },
            { pubkey: vault(), isSigner: false, isWritable: true },
          ],
          data: ixDisc(name),
        });
        assert.ok(isErr(send(c.svm, c.user, [ix])), `a stranger must not be able to ${name}`);
      }
    });
  });
});
