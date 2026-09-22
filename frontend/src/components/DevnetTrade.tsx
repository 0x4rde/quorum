'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Explain, Num } from './ui';
import { Logo } from './Logo';
import { DEVNET, type DevnetVault } from '@/lib/devnet';
import type { LiveVault } from '@/lib/live';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ata,
  createAtaIdempotent,
  mintInKind,
  redeemInKind,
} from '@/lib/program';
import { buildSwapAt, outputDecimals, quoteAt, readReserves, reserveKeys } from '@/lib/pool';
import { EXPLORER_TX, useWallet } from '@/lib/wallet';
import { readU64LE } from '@/lib/bytes';

/**
 * Deposit and withdraw.
 *
 * Paying with test USDC is the default, because it is the one token that
 * opens every vault. The vault itself cannot accept dollars: it only ever
 * takes a holding it already recognises. So the panel buys one first, in the
 * same transaction, which is exactly the arrangement mainnet would use with
 * an aggregator and is the reason the vault program contains no exchange
 * call of its own.
 *
 * Which holding it buys is not a question worth asking a visitor. The panel
 * picks whichever is furthest below its target weight, so an ordinary deposit
 * nudges the basket back towards balance instead of away from it. That also
 * avoids the failure a naive choice runs into: depositing into the holding
 * that is already heaviest is what trips the issuer cap.
 */

const RPC = 'https://api.devnet.solana.com';
const WSOL = 'So11111111111111111111111111111111111111112';

/** These pools are shallow, so the tolerance is wide on purpose. */
const SLIPPAGE_BPS = 200n;

/**
 * `CloseAccount`: instruction 9.
 *
 * Only reached by a vault holding wrapped SOL, where closing the account is
 * how the holding becomes spendable SOL again. No listed vault holds one
 * today; the branch stays because whether a vault does is a config setting,
 * not a code change.
 */
function closeAccount(account: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(Uint8Array.from([9])),
  });
}

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'done'; what: string; signature: string }
  | { kind: 'error'; message: string };

export function DevnetTrade({ vault, live }: { vault: DevnetVault; live: LiveVault | null }) {
  const { pubkey, available, connecting, connect, disconnect, send } = useWallet();
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('100');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [indexBalance, setIndexBalance] = useState<bigint | null>(null);
  const [expectedOut, setExpectedOut] = useState<number | null>(null);

  const conn = useMemo(() => new Connection(RPC, 'confirmed'), []);
  const usdcMint = useMemo(
    () => (DEVNET.usdcMint ? new PublicKey(DEVNET.usdcMint) : null),
    [],
  );

  const legs = useMemo(
    () =>
      vault.wrappers.map((w) => ({
        ...w,
        mintKey: new PublicKey(w.mint),
        tokenProgram:
          w.multiplierSource === 'TOKEN2022_SCALED_UI' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
        pool: DEVNET.pools[`${w.key}-mUSDC`] ?? null,
      })),
    [vault],
  );
  const indexMintKey = useMemo(() => new PublicKey(vault.indexMint), [vault.indexMint]);

  /**
   * The holding to buy: whichever is furthest below its target weight, among
   * those that can actually be bought here.
   *
   * Every holding in the equity vaults now has a pool, so those two are
   * normally the same holding and a deposit pulls the basket towards its
   * targets rather than away. They can still come apart — a pool can be
   * missing, or drained — and when they do the panel says which holding it
   * would rather have bought instead of quietly claiming a balancing act it
   * is not performing. What corrects the rest of the drift is the
   * permissionless rebalance, which needs no pool at all.
   */
  const choice = useMemo(() => {
    const purchasable = legs.filter((l) => l.pool);
    if (purchasable.length === 0) return null;

    const driftOf = (key: string) => {
      const leg = live?.legs.find((x) => x.key === key);
      return leg ? leg.weightBps - leg.targetWeightBps : 0;
    };
    const best = [...purchasable].sort((a, b) => driftOf(a.key) - driftOf(b.key))[0];

    // Is something else further below target that we simply cannot buy?
    const overall = live
      ? [...live.legs].sort(
          (a, b) => a.weightBps - a.targetWeightBps - (b.weightBps - b.targetWeightBps),
        )[0]
      : null;
    const blocked = overall && overall.key !== best.key ? overall : null;

    return { leg: best, drift: driftOf(best.key), blocked };
  }, [legs, live]);

  const target = choice?.leg ?? null;

  const refresh = useCallback(async () => {
    if (!pubkey) {
      setUsdcBalance(null);
      setIndexBalance(null);
      return;
    }
    const accounts = [
      ...(usdcMint ? [ata(usdcMint, pubkey, TOKEN_PROGRAM)] : []),
      ata(indexMintKey, pubkey, TOKEN_2022_PROGRAM),
    ];
    const infos = await conn.getMultipleAccountsInfo(accounts);
    if (usdcMint) {
      setUsdcBalance(infos[0] ? readU64LE(infos[0]!.data, 64) : 0n);
      setIndexBalance(infos[1] ? readU64LE(infos[1]!.data, 64) : 0n);
    } else {
      setIndexBalance(infos[0] ? readU64LE(infos[0]!.data, 64) : 0n);
    }
  }, [conn, indexMintKey, pubkey, usdcMint]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  // Quote the purchase so the panel shows what the money actually buys.
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (tab !== 'deposit' || !target?.pool || !usdcMint) return setExpectedOut(null);
      const raw = toRaw(amount, 6);
      if (raw <= 0n) return setExpectedOut(null);
      try {
        const infos = await conn.getMultipleAccountsInfo(
          reserveKeys(target.pool, usdcMint),
        );
        if (!alive) return;
        const { reserveIn, reserveOut } = readReserves(target.pool, infos, usdcMint);
        const out = quoteAt(target.pool, reserveIn, reserveOut, raw);
        setExpectedOut(Number(out) / 10 ** outputDecimals(target.pool, usdcMint));
      } catch {
        if (alive) setExpectedOut(null);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [amount, conn, tab, target, usdcMint]);

  const run = async (what: string, fn: () => Promise<string>) => {
    setStatus({ kind: 'busy', what });
    try {
      const signature = await fn();
      setStatus({ kind: 'done', what, signature });
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  };

  const doFaucet = () =>
    run('Getting test USDC', async () => {
      const r = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: pubkey!.toBase58(), symbol: vault.symbol }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `faucet ${r.status}`);
      return j.signature as string;
    });

  const doDeposit = () =>
    run(`Depositing into ${vault.symbol}`, async () => {
      if (!vault.priceAccount) throw new Error('This vault has no price posted.');
      if (!target?.pool || !usdcMint) throw new Error('No route into this vault yet.');
      const spend = toRaw(amount, 6);
      if (spend <= 0n) throw new Error('Enter an amount above zero.');
      if (usdcBalance != null && spend > usdcBalance) {
        throw new Error('That is more test USDC than you hold. Press "get test USDC".');
      }

      const infos = await conn.getMultipleAccountsInfo(reserveKeys(target.pool, usdcMint));
      const { reserveIn, reserveOut } = readReserves(target.pool, infos, usdcMint);
      const expect = quoteAt(target.pool, reserveIn, reserveOut, spend);
      if (expect <= 0n) throw new Error('That pool has no liquidity right now.');

      const legRefs = legs.map((l) => ({ mint: l.mintKey, tokenProgram: l.tokenProgram }));
      return send(conn, [
        createAtaIdempotent({
          payer: pubkey!, owner: pubkey!, mint: target.mintKey, tokenProgram: target.tokenProgram,
        }),
        createAtaIdempotent({
          payer: pubkey!, owner: pubkey!, mint: indexMintKey, tokenProgram: TOKEN_2022_PROGRAM,
        }),
        buildSwapAt({
          pool: target.pool,
          user: pubkey!,
          inputMint: usdcMint,
          amountIn: spend,
          minimumAmountOut: (expect * (10_000n - SLIPPAGE_BPS)) / 10_000n,
        }),
        mintInKind({
          user: pubkey!,
          symbol: vault.symbol,
          mint: target.mintKey,
          wrapperTokenProgram: target.tokenProgram,
          priceUpdate: new PublicKey(vault.priceAccount),
          legs: legRefs,
          // The swap lands in the same account this reads, so deposit what
          // the pool is expected to give, less the slippage allowance. The
          // program measures the real balance change regardless.
          amount: (expect * (10_000n - SLIPPAGE_BPS)) / 10_000n,
          minIndexOut: 0n,
        }),
      ]);
    });

  const nativeLeg = legs.find((l) => l.mint === WSOL);

  const doWithdraw = () =>
    run(`Withdrawing from ${vault.symbol}`, async () => {
      const raw = toRaw(amount, 9); // index tokens carry 9 decimals
      if (raw <= 0n) throw new Error('Enter an amount above zero.');
      if (indexBalance != null && raw > indexBalance) {
        throw new Error(`That is more ${vault.symbol} than you hold.`);
      }
      return send(conn, [
        ...legs.map((l) =>
          createAtaIdempotent({
            payer: pubkey!, owner: pubkey!, mint: l.mintKey, tokenProgram: l.tokenProgram,
          }),
        ),
        redeemInKind({
          user: pubkey!,
          symbol: vault.symbol,
          legs: legs.map((l) => ({ mint: l.mintKey, tokenProgram: l.tokenProgram })),
          indexAmount: raw,
        }),
        ...(nativeLeg
          ? [closeAccount(ata(nativeLeg.mintKey, pubkey!, TOKEN_PROGRAM), pubkey!)]
          : []),
      ]);
    });

  const busy = status.kind === 'busy';

  if (!pubkey) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-ink">Try it</div>
          <div className="mt-0.5 text-[11.5px] text-faint">
            {available
              ? 'Connect a wallet. Test dollars are free.'
              : 'No Solana wallet detected. Phantom, Solflare and Backpack all work.'}
          </div>
        </div>
        <button
          onClick={() => void connect()}
          disabled={connecting}
          className="rounded-[5px] bg-accent px-4 py-2.5 text-[13px] font-bold text-[#14171A] transition-colors hover:bg-accent-hover disabled:opacity-60"
          style={{ minHeight: 40 }}
        >
          {connecting ? 'Connecting…' : available ? 'Connect wallet' : 'Get a wallet'}
        </button>
      </div>
    );
  }

  const unit = tab === 'deposit' ? 'test USDC' : vault.symbol;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(['deposit', 'withdraw'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setAmount(t === 'deposit' ? '100' : '0.01');
              }}
              className={`mono rounded-[5px] px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] transition-colors ${
                tab === t ? 'bg-[#1B1F23] text-ink' : 'text-faint hover:text-dim'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => void disconnect()}
          className="mono text-[10.5px] uppercase tracking-[0.12em] text-faint hover:text-dim"
          title={pubkey.toBase58()}
        >
          {pubkey.toBase58().slice(0, 4)}…{pubkey.toBase58().slice(-4)} · disconnect
        </button>
      </div>

      <label className="block">
        <span className="label">{tab === 'deposit' ? 'Amount in test USDC' : `Amount of ${vault.symbol}`}</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="mono mt-1 w-full rounded-[5px] border border-interactive bg-[#101316] px-3 py-2.5 text-[15px] text-ink outline-none focus:border-accent"
        />
      </label>

      {tab === 'deposit' && target && (
        <div className="flex items-center gap-2.5 rounded-[5px] border border-hairline bg-inset px-3 py-2.5">
          <Logo wrapperKey={target.mainnetKey ?? target.key} size={22} />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-body">
              Buys <span className="text-ink">{target.standsFor}</span>
              {expectedOut != null && (
                <span className="mono text-faint"> · about {expectedOut.toFixed(6)}</span>
              )}
            </div>
            <div className="text-[10.5px] text-faint">
              {choice && choice.drift <= 0
                ? 'chosen automatically: it is furthest below its target weight'
                : choice?.blocked
                  ? `the most underweight holding with a pool; ${choice.blocked.standsFor} is further below target but cannot be bought here`
                  : 'the only holding buyable here'}
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => void (tab === 'deposit' ? doDeposit() : doWithdraw())}
        disabled={busy}
        className="w-full rounded-[5px] bg-accent px-4 py-3 text-[13px] font-bold text-[#14171A] transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        style={{ minHeight: 44 }}
      >
        {busy
          ? `${status.what}…`
          : tab === 'deposit'
            ? `Deposit ${amount || '0'} ${unit}`
            : `Withdraw ${vault.symbol}`}
      </button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
        <span className="label">You hold</span>
        <span className="text-dim">
          test USDC <Num value={fromRaw(usdcBalance ?? 0n, 6)} />
        </span>
        <span className="text-dim">
          {vault.symbol} <Num value={fromRaw(indexBalance ?? 0n, 9)} tone="good" />
        </span>
        <button
          onClick={() => void doFaucet()}
          disabled={busy}
          className="mono rounded-[5px] border border-interactive px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          get test USDC
        </button>
      </div>

      <p className="text-[11px] leading-snug text-faint">
        {tab === 'deposit'
          ? 'One transaction: the test USDC buys a holding at a public pool, then the vault takes it in. The vault never sees the trade.'
          : 'Withdrawing returns a slice of every holding, reads no price, and stays open even when deposits are shut.'}
      </p>

      {status.kind === 'error' && <Explain tone="bad">{status.message}</Explain>}
      {status.kind === 'done' && (
        <Explain tone="good">
          {status.what} confirmed.{' '}
          <a
            href={EXPLORER_TX(status.signature)}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            View transaction &#8599;
          </a>
        </Explain>
      )}
    </div>
  );
}

/** Whole tokens to base units, without floating point. */
function toRaw(input: string, decimals: number): bigint {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return 0n;
  const [whole, frac = ''] = t.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function fromRaw(raw: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const frac = (raw % d).toString().padStart(decimals, '0').slice(0, 4);
  return `${raw / d}.${frac}`;
}
