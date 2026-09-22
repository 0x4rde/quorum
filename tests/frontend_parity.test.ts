/**
 * The frontend builds its own instructions. This checks they are the same
 * ones.
 *
 * `frontend/src/lib/program.ts` duplicates part of `scripts/lib/ix.ts`
 * because the frontend deploys from its own directory and cannot import
 * across the repo root. Duplicates drift, and a drifted account order is not
 * a crash: Anchor matches positionally, so the wrong account in the right
 * slot is a silent wrong-account bug. These tests build the same instruction
 * through both paths and compare the bytes.
 *
 * They also recompute the discriminators the frontend hardcodes, since the
 * browser has no synchronous SHA-256 and the constants are otherwise
 * unchecked.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

import * as scripts from '../scripts/lib/ix.js';
import * as fe from '../frontend/src/lib/program.js';
import * as scriptSwap from '../scripts/lib/swap.js';
import * as feSwap from '../frontend/src/lib/swap.js';
import * as scriptCpmm from '../scripts/lib/cpmm.js';
import * as feCpmm from '../frontend/src/lib/cpmm.js';

const SYMBOL = 'qGOLD';
const user = new PublicKey('3KVQ6genEwmPeJ94rXGioCN2PnA9iyxnE3RwPFtrRpEN');
const priceUpdate = new PublicKey('E9dQojXoTFL7ZvXA7xU1nPjqRFhuSx7Uy7fiSpNjkepp');

/** Deterministic mints, so a failure is reproducible rather than flaky. */
const mints = [
  new PublicKey('9e2XqP7Mr1owSSgUaXQaPSkSowEJ5vtCT2oKRvr8kZFQ'),
  new PublicKey('RNhZq2fY1dsXQNmKEA1XyFzt2NvBFuFoCw2GcthToRK'),
  new PublicKey('GUWouRhx8HTmwXbeD4ZzKo5HSH6sEub67xCGqEVKEEoz'),
];

function compare(a: TransactionInstruction, b: TransactionInstruction, what: string) {
  assert.equal(a.programId.toBase58(), b.programId.toBase58(), `${what}: program id`);
  assert.equal(
    Buffer.from(a.data).toString('hex'),
    Buffer.from(b.data).toString('hex'),
    `${what}: instruction data`,
  );
  assert.equal(a.keys.length, b.keys.length, `${what}: account count`);
  for (let i = 0; i < a.keys.length; i++) {
    assert.equal(
      `${a.keys[i].pubkey.toBase58()} s=${a.keys[i].isSigner} w=${a.keys[i].isWritable}`,
      `${b.keys[i].pubkey.toBase58()} s=${b.keys[i].isSigner} w=${b.keys[i].isWritable}`,
      `${what}: account ${i}`,
    );
  }
}

describe('the frontend builds the same instructions as the scripts', () => {
  it('derives the same PDAs', () => {
    const vaultA = scripts.SEEDS_FOR_TEST.vault(SYMBOL);
    const vaultB = fe.SEEDS.vault(SYMBOL);
    assert.equal(vaultA.toBase58(), vaultB.toBase58(), 'vault');
    assert.equal(
      scripts.SEEDS_FOR_TEST.indexMint(vaultA).toBase58(),
      fe.SEEDS.indexMint(vaultB).toBase58(),
      'index mint',
    );
    for (const m of mints) {
      assert.equal(
        scripts.SEEDS_FOR_TEST.wrapper(vaultA, m).toBase58(),
        fe.SEEDS.wrapper(vaultB, m).toBase58(),
        'wrapper config',
      );
      assert.equal(
        scripts.SEEDS_FOR_TEST.vaultToken(vaultA, m).toBase58(),
        fe.SEEDS.vaultToken(vaultB, m).toBase58(),
        'vault token account',
      );
    }
  });

  it('derives the same associated token accounts', () => {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      for (const m of mints) {
        assert.equal(
          getAssociatedTokenAddressSync(m, user, false, program).toBase58(),
          fe.ata(m, user, program).toBase58(),
          `ata for ${program.toBase58()}`,
        );
      }
    }
  });

  it('hardcodes the right discriminators', () => {
    for (const name of ['mint_in_kind', 'redeem_in_kind', 'update_nav'] as const) {
      const expected = createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
      assert.equal(
        Buffer.from(fe.DISC[name]).toString('hex'),
        expected.toString('hex'),
        `discriminator for ${name}`,
      );
    }
  });

  it('builds an identical mint_in_kind', () => {
    const vault = fe.SEEDS.vault(SYMBOL);
    const a = scripts.mintInKind({
      user,
      symbol: SYMBOL,
      mint: mints[0],
      userWrapperAccount: getAssociatedTokenAddressSync(mints[0], user, false, TOKEN_PROGRAM_ID),
      userIndexAccount: getAssociatedTokenAddressSync(
        fe.SEEDS.indexMint(vault), user, false, TOKEN_2022_PROGRAM_ID,
      ),
      priceUpdate,
      wrapperTokenProgram: TOKEN_PROGRAM_ID,
      legs: mints.map((mint) => ({ mint })),
      amount: 123_456_789n,
      minIndexOut: 42n,
    });
    const b = fe.mintInKind({
      user,
      symbol: SYMBOL,
      mint: mints[0],
      wrapperTokenProgram: TOKEN_PROGRAM_ID,
      priceUpdate,
      legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      amount: 123_456_789n,
      minIndexOut: 42n,
    });
    compare(a, b, 'mint_in_kind');
  });

  it('builds an identical redeem_in_kind', () => {
    const a = scripts.redeemInKind({
      user,
      symbol: SYMBOL,
      userIndexAccount: getAssociatedTokenAddressSync(
        fe.SEEDS.indexMint(fe.SEEDS.vault(SYMBOL)), user, false, TOKEN_2022_PROGRAM_ID,
      ),
      legs: mints.map((mint) => ({
        mint,
        userAccount: getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID),
      })),
      tokenProgram: TOKEN_PROGRAM_ID,
      indexAmount: 987_654_321n,
    });
    const b = fe.redeemInKind({
      user,
      symbol: SYMBOL,
      legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      indexAmount: 987_654_321n,
    });
    compare(a, b, 'redeem_in_kind');
  });

  it('builds a mint the program would accept for a Token-2022 leg', () => {
    // The wrapper token program differs per leg on the equity vaults, and
    // getting it wrong sends the transfer to the wrong program. Check the
    // user's source account is derived under the right one.
    const mint = mints[1];
    const ix = fe.mintInKind({
      user,
      symbol: 'qSPY',
      mint,
      wrapperTokenProgram: TOKEN_2022_PROGRAM_ID,
      priceUpdate,
      legs: [{ mint, tokenProgram: TOKEN_2022_PROGRAM_ID }],
      amount: 1n,
      minIndexOut: 0n,
    });
    const expected = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID);
    assert.equal(ix.keys[5].pubkey.toBase58(), expected.toBase58());
  });

  it('never marks the user writable, since the program does not need it', () => {
    const ix = fe.mintInKind({
      user: Keypair.generate().publicKey,
      symbol: SYMBOL,
      mint: mints[0],
      wrapperTokenProgram: TOKEN_PROGRAM_ID,
      priceUpdate,
      legs: [{ mint: mints[0], tokenProgram: TOKEN_PROGRAM_ID }],
      amount: 1n,
      minIndexOut: 0n,
    });
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, false);
  });

  /**
   * The browser's `Buffer` is a polyfill and has none of Node's BigInt
   * accessors. Code using them typechecks against @types/node, passes here,
   * builds cleanly, and throws "writeBigUInt64LE is not a function" the first
   * time a user clicks deposit. Deleting the methods reproduces that in a
   * test, which is the only place it is cheap to find.
   */
  it('builds instructions without Node-only Buffer methods', () => {
    const proto = Buffer.prototype as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const m of ['writeBigUInt64LE', 'writeBigInt64LE', 'readBigUInt64LE', 'readBigInt64LE']) {
      saved[m] = proto[m];
      delete proto[m];
    }
    try {
      const built = fe.mintInKind({
        user,
        symbol: SYMBOL,
        mint: mints[0],
        wrapperTokenProgram: TOKEN_PROGRAM_ID,
        priceUpdate,
        legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
        amount: 123_456_789n,
        minIndexOut: 42n,
      });
      // 8 discriminator + 8 amount + 8 min_index_out, and the amount must
      // survive the round trip rather than silently encoding as zero.
      assert.equal(built.data.length, 24);
      const dv = new DataView(built.data.buffer, built.data.byteOffset, built.data.byteLength);
      assert.equal(dv.getBigUint64(8, true), 123_456_789n);
      assert.equal(dv.getBigUint64(16, true), 42n);

      const redeem = fe.redeemInKind({
        user,
        symbol: SYMBOL,
        legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
        indexAmount: 987_654_321n,
      });
      assert.equal(redeem.data.length, 16);
      fe.createAtaIdempotent({
        payer: user, owner: user, mint: mints[0], tokenProgram: TOKEN_PROGRAM_ID,
      });
    } finally {
      for (const [m, fn] of Object.entries(saved)) proto[m] = fn;
    }
  });

  it('builds an identical begin_rebalance', () => {
    const a = scripts.beginSwap({
      which: 'begin_rebalance',
      caller: user,
      symbol: SYMBOL,
      sourceMint: mints[0],
      destMint: mints[1],
      callerSourceAccount: getAssociatedTokenAddressSync(mints[0], user, false, TOKEN_PROGRAM_ID),
      priceUpdate,
      sourceTokenProgram: TOKEN_PROGRAM_ID,
      legs: mints.map((mint) => ({ mint })),
      amount: 5_000_000n,
    });
    const b = fe.beginRebalance({
      caller: user,
      symbol: SYMBOL,
      sourceMint: mints[0],
      destMint: mints[1],
      sourceTokenProgram: TOKEN_PROGRAM_ID,
      priceUpdate,
      legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      amount: 5_000_000n,
    });
    compare(a, b, 'begin_rebalance');
  });

  it('builds an identical end_swap', () => {
    const vault = fe.SEEDS.vault(SYMBOL);
    const a = scripts.endSwap({
      caller: user,
      symbol: SYMBOL,
      sourceMint: mints[0],
      destMint: mints[1],
      callerDestAccount: getAssociatedTokenAddressSync(mints[1], user, false, TOKEN_PROGRAM_ID),
      callerIndexAccount: getAssociatedTokenAddressSync(
        fe.SEEDS.indexMint(vault), user, false, TOKEN_2022_PROGRAM_ID,
      ),
      priceUpdate,
      destTokenProgram: TOKEN_PROGRAM_ID,
      legs: mints.map((mint) => ({ mint })),
      amount: 4_999_000n,
    });
    const b = fe.endSwap({
      caller: user,
      symbol: SYMBOL,
      sourceMint: mints[0],
      destMint: mints[1],
      destTokenProgram: TOKEN_PROGRAM_ID,
      priceUpdate,
      legs: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ID })),
      amount: 4_999_000n,
    });
    compare(a, b, 'end_swap');
  });

  it('derives the same swap ticket', () => {
    assert.equal(
      scripts.SEEDS_FOR_TEST.swapTicket(scripts.SEEDS_FOR_TEST.vault(SYMBOL)).toBase58(),
      fe.SEEDS.swapTicket(fe.SEEDS.vault(SYMBOL)).toBase58(),
    );
  });

  it('builds an identical pool swap', () => {
    const pool = {
      swapAccount: '83vd9Sx3KxxnG64okoVYSKV8CgWsEWMPyEgGMTHfbrKb',
      authority: '4e9D2YbCMNfAKM4rXwiVvXJVmDQnDWDeUpKcTvNjmYwK',
      poolMint: 'CwyMYvSL33fQAfYaCqeM8CgV8rjbYVgHiLzcBb8SArps',
      tokenA: '9C5b2AjfEvTqjM8pBm9unNa7cmPJdsHtecgog59Nzp6H',
      tokenB: '8zHYoAYZYTaGUfes7YrXJfuKVwiDJubkgN5dkmvD28iW',
      mintA: mints[0].toBase58(),
      mintB: mints[1].toBase58(),
      feeAccount: 'DUHV8z6Y71WYUj1Sw5aEoAYoxE1VWTXyczcyKPbnAUXH',
      programA: TOKEN_PROGRAM_ID.toBase58(),
      programB: TOKEN_PROGRAM_ID.toBase58(),
      decimalsA: 8,
    };
    const a = scriptSwap.buildSwap({
      pool, user, inputMint: mints[1], amountIn: 1_000_000n, minimumAmountOut: 900n,
    });
    const b = feSwap.buildSwap({
      pool, user, inputMint: mints[1], amountIn: 1_000_000n, minimumAmountOut: 900n,
    });
    compare(a, b, 'pool swap');
  });

  it('quotes a swap the same way on both sides', () => {
    for (const [ri, ro, ain] of [
      [400_000_000n, 47_000_000n, 30_000_000n],
      [21_600_000_000n, 500_000_000n, 1_000_000n],
    ] as const) {
      assert.equal(scriptSwap.quote(ri, ro, ain), feSwap.quote(ri, ro, ain));
    }
  });

  // The second venue. The Token-2022 holdings trade on Raydium's CPMM
  // because the Token Swap build on devnet rejects that token program, so
  // the same duplication and the same risk of drift applies again.
  const cpmmPool = {
    kind: 'cpmm' as const,
    pair: 'mSPYx-mUSDC',
    poolId: 'Ajr45ACkjjrTgudviwMUh22BfhS8HeQZPTY88zxHgtAX',
    ammConfig: '5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy',
    observation: '9C5b2AjfEvTqjM8pBm9unNa7cmPJdsHtecgog59Nzp6H',
    lpMint: 'CwyMYvSL33fQAfYaCqeM8CgV8rjbYVgHiLzcBb8SArps',
    mint0: mints[0].toBase58(),
    mint1: mints[1].toBase58(),
    vault0: '8zHYoAYZYTaGUfes7YrXJfuKVwiDJubkgN5dkmvD28iW',
    vault1: 'DUHV8z6Y71WYUj1Sw5aEoAYoxE1VWTXyczcyKPbnAUXH',
    program0: TOKEN_2022_PROGRAM_ID.toBase58(),
    program1: TOKEN_PROGRAM_ID.toBase58(),
    decimals0: 8,
    decimals1: 6,
  };

  it('agrees on the CPMM program and its authority', () => {
    assert.equal(
      scriptCpmm.CPMM_PROGRAM.toBase58(),
      feCpmm.CPMM_PROGRAM.toBase58(),
      'program id',
    );
    assert.equal(
      scriptCpmm.CPMM_AUTHORITY.toBase58(),
      feCpmm.CPMM_AUTHORITY.toBase58(),
      'authority PDA',
    );
  });

  it('builds an identical CPMM swap, either way round', () => {
    for (const inputMint of [mints[1], mints[0]]) {
      const args = { user, inputMint, amountIn: 1_000_000n, minimumAmountOut: 900n };
      compare(
        scriptCpmm.buildCpmmSwap({ pool: cpmmPool, ...args }),
        feCpmm.buildCpmmSwap({ pool: cpmmPool, ...args }),
        `CPMM swap paying in ${inputMint.toBase58()}`,
      );
    }
  });

  it('quotes a CPMM swap the same way on both sides', () => {
    for (const [ri, ro, ain] of [
      [77_790_766_084n, 10_000_000_000n, 1_000_000_000n],
      [33_854_152_170n, 20_000_000_000n, 7n],
      [1n, 1n, 1n],
    ] as const) {
      assert.equal(
        scriptCpmm.quoteCpmm(ri, ro, ain),
        feCpmm.quoteCpmm(ri, ro, ain),
        'CPMM quote',
      );
    }
  });

  it('reads CPMM reserves the same way, net of the fees the pool owes', () => {
    // A pool state with 7 of token0 and 11 of token1 owed away, and vaults
    // holding 1,000 and 2,000.
    const state = Buffer.alloc(400);
    const PROTOCOL_FEE_0 = 8 + 32 * 10 + 5 + 8;
    state.writeBigUInt64LE(3n, PROTOCOL_FEE_0); // protocol, token0
    state.writeBigUInt64LE(5n, PROTOCOL_FEE_0 + 8); // protocol, token1
    state.writeBigUInt64LE(4n, PROTOCOL_FEE_0 + 16); // fund, token0
    state.writeBigUInt64LE(6n, PROTOCOL_FEE_0 + 24); // fund, token1
    const vault = (amount: bigint) => {
      const d = Buffer.alloc(165);
      d.writeBigUInt64LE(amount, 64);
      return { data: d };
    };
    const infos = [{ data: state }, vault(1_000n), vault(2_000n)];

    const fromScripts = scriptCpmm.cpmmReserves(
      async () => infos,
      cpmmPool,
      mints[0],
    );
    const fromFrontend = feCpmm.readCpmmReserves(cpmmPool, infos, mints[0]);
    assert.deepEqual(fromFrontend, { reserveIn: 993n, reserveOut: 1_989n });
    return fromScripts.then((r) => assert.deepEqual(r, fromFrontend));
  });

  it('builds a CPMM swap without Node-only Buffer methods', () => {
    const proto = Buffer.prototype as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const m of ['writeBigUInt64LE', 'writeBigInt64LE', 'readBigUInt64LE', 'readBigInt64LE']) {
      saved[m] = proto[m];
      delete proto[m];
    }
    try {
      const built = feCpmm.buildCpmmSwap({
        pool: cpmmPool,
        user,
        inputMint: mints[1],
        amountIn: 123_456_789n,
        minimumAmountOut: 42n,
      });
      assert.equal(built.data.length, 24);
      const dv = new DataView(built.data.buffer, built.data.byteOffset, built.data.byteLength);
      assert.equal(dv.getBigUint64(8, true), 123_456_789n);
      assert.equal(dv.getBigUint64(16, true), 42n);
    } finally {
      for (const [m, fn] of Object.entries(saved)) proto[m] = fn;
    }
  });
});
