'use client';

import { useMemo, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { Explain, Num } from './ui';
import { Logo } from './Logo';
import { DEVNET } from '@/lib/devnet';
import type { LiveVault } from '@/lib/live';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ata,
  beginRebalance,
  createAtaIdempotent,
  endSwap,
} from '@/lib/program';
import { EXPLORER_TX, useWallet } from '@/lib/wallet';
import { readU64LE } from '@/lib/bytes';

/**
 * Run a rebalance, from the browser, as anyone.
 *
 * This is the page's claim made testable. The vault lends the overweight
 * holding to whoever calls, and requires the underweight one back before the
 * transaction ends. Here the caller settles from their own balance, which is
 * a real trade from their side: they give up one token and receive another.
 * On mainnet the same two instructions would bracket a swap at an exchange;
 * the vault cannot tell the difference and does not try to, which is what
 * makes it safe to leave open.
 *
 * The caller keeps whatever the bounds allow, up to the vault's maximum
 * tolerated cost. That margin is the incentive, and it is enforced on chain
 * rather than promised here.
 */
const RPC = 'https://api.devnet.solana.com';

type State =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'done'; signature: string }
  | { kind: 'error'; message: string };

export interface Opportunity {
  vault: LiveVault;
  /** The holding that is over its target. */
  source: LiveVault['legs'][number];
  /** The holding furthest under its target. */
  dest: LiveVault['legs'][number];
  driftPp: number;
  /** Tokens of the source holding the caller may borrow. */
  lendTokens: number;
  /** Tokens of the destination holding needed to settle. */
  repayTokens: number;
}

/** Work out what a caller could do right now, from live balances. */
export function findOpportunity(vaults: LiveVault[]): Opportunity | null {
  let best: Opportunity | null = null;

  for (const v of vaults) {
    if (v.status !== 'ACTIVE' || !v.config || v.legs.length < 2) continue;
    const triggerPp = v.config.rebalanceDriftBps / 100;

    for (const source of v.legs) {
      const driftPp = (source.weightBps - source.targetWeightBps) / 100;
      if (driftPp < triggerPp) continue;

      const dest = [...v.legs]
        .filter((l) => l.key !== source.key)
        .sort((a, b) => a.weightBps - a.targetWeightBps - (b.weightBps - b.targetWeightBps))[0];
      if (!dest) continue;

      // The vault caps one call at a fraction of the leg it lends from.
      const lendTokens = (source.balance * v.config.maxSwapBps) / 10_000;
      if (lendTokens <= 0) continue;

      // Settle the same value back. Each holding counts for a different
      // amount per token, so convert through units rather than assuming
      // one for one, and round up so rounding never lands under the floor.
      const sourcePerToken = source.balance > 0 ? source.units / source.balance : 1;
      const destPerToken = dest.balance > 0 ? dest.units / dest.balance : 1;
      const repayTokens = Math.ceil(((lendTokens * sourcePerToken) / destPerToken) * 1e6) / 1e6;

      if (!best || driftPp > best.driftPp) {
        best = { vault: v, source, dest, driftPp, lendTokens, repayTokens };
      }
    }
  }
  return best;
}

export function RebalancePanel({ opportunity }: { opportunity: Opportunity | null }) {
  const { pubkey, available, connecting, connect, send } = useWallet();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const conn = useMemo(() => new Connection(RPC, 'confirmed'), []);

  if (!opportunity) {
    return (
      <p className="text-[12.5px] leading-relaxed text-faint">
        Every holding is inside its drift limit, so there is nothing to correct. When one
        drifts far enough, this panel will offer the trade to anyone who wants it.
      </p>
    );
  }

  const { vault, source, dest, driftPp, lendTokens, repayTokens } = opportunity;
  const config = DEVNET.vaults.find((v) => v.symbol === vault.symbol);
  const busy = state.kind === 'busy';

  const run = async () => {
    if (!pubkey || !config || !vault.priceAccount) return;
    setState({ kind: 'busy', what: 'Preparing' });
    try {
      const legs = config.wrappers.map((w) => ({
        mint: new PublicKey(w.mint),
        tokenProgram:
          w.multiplierSource === 'TOKEN2022_SCALED_UI' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      }));
      const find = (key: string) => {
        const w = config.wrappers.find((x) => x.key === key)!;
        return {
          mint: new PublicKey(w.mint),
          decimals: w.decimals,
          tokenProgram:
            w.multiplierSource === 'TOKEN2022_SCALED_UI' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
        };
      };
      const src = find(source.key);
      const dst = find(dest.key);
      const indexMint = new PublicKey(config.indexMint);

      // The caller settles from their own balance, so they need the
      // destination token first. Ask the faucet when they are short.
      const held = await conn.getAccountInfo(ata(dst.mint, pubkey, dst.tokenProgram));
      const have = held ? Number(readU64LE(held.data, 64)) / 10 ** dst.decimals : 0;
      if (have < repayTokens) {
        setState({ kind: 'busy', what: `Getting ${dest.key} to settle with` });
        const r = await fetch('/api/faucet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: pubkey.toBase58(), symbol: vault.symbol }),
        });
        const j = await r.json();
        if (!r.ok) {
          throw new Error(
            `You need about ${repayTokens.toFixed(4)} ${dest.key} to settle this trade. ${j.error ?? ''}`,
          );
        }
      }

      setState({ kind: 'busy', what: 'Rebalancing' });
      const raw = (n: number, d: number) => BigInt(Math.floor(n * 10 ** d));
      const signature = await send(conn, [
        createAtaIdempotent({
          payer: pubkey, owner: pubkey, mint: src.mint, tokenProgram: src.tokenProgram,
        }),
        createAtaIdempotent({
          payer: pubkey, owner: pubkey, mint: indexMint, tokenProgram: TOKEN_2022_PROGRAM,
        }),
        beginRebalance({
          caller: pubkey,
          symbol: vault.symbol,
          sourceMint: src.mint,
          destMint: dst.mint,
          sourceTokenProgram: src.tokenProgram,
          priceUpdate: new PublicKey(vault.priceAccount),
          legs,
          amount: raw(lendTokens, src.decimals),
        }),
        endSwap({
          caller: pubkey,
          symbol: vault.symbol,
          sourceMint: src.mint,
          destMint: dst.mint,
          destTokenProgram: dst.tokenProgram,
          priceUpdate: new PublicKey(vault.priceAccount),
          legs,
          amount: raw(repayTokens, dst.decimals),
        }),
      ]);
      setState({ kind: 'done', signature });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-relaxed text-body">
        <strong className="text-ink">{source.standsFor}</strong> in {vault.symbol} is{' '}
        {driftPp.toFixed(2)} points over its target. The vault will lend it to anyone who
        returns {dest.standsFor} of equal value in the same transaction.
      </p>

      <div className="flex items-center gap-3 rounded-[6px] border border-hairline bg-inset px-4 py-3">
        <div className="flex items-center gap-2">
          <Logo wrapperKey={source.mainnetKey ?? source.key} size={26} />
          <div>
            <div className="label">You receive</div>
            <Num value={`${lendTokens.toFixed(4)} ${source.key}`} className="text-[13px]" />
          </div>
        </div>
        <span className="mono px-2 text-[16px] text-faint">&#8594;</span>
        <div className="flex items-center gap-2">
          <Logo wrapperKey={dest.mainnetKey ?? dest.key} size={26} />
          <div>
            <div className="label">You return</div>
            <Num value={`${repayTokens.toFixed(4)} ${dest.key}`} className="text-[13px]" />
          </div>
        </div>
      </div>

      {!pubkey ? (
        <button
          onClick={() => void connect()}
          disabled={connecting}
          className="w-full rounded-[5px] bg-accent px-4 py-3 text-[13px] font-bold text-[#14171A] transition-colors hover:bg-accent-hover disabled:opacity-60"
          style={{ minHeight: 44 }}
        >
          {connecting ? 'Connecting…' : available ? 'Connect wallet to run it' : 'Get a wallet'}
        </button>
      ) : (
        <button
          onClick={() => void run()}
          disabled={busy}
          className="w-full rounded-[5px] bg-accent px-4 py-3 text-[13px] font-bold text-[#14171A] transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          style={{ minHeight: 44 }}
        >
          {busy ? `${state.what}…` : 'Run this rebalance'}
        </button>
      )}

      <p className="text-[11px] leading-snug text-faint">
        One transaction. If the vault would end up worse off by more than it tolerates,
        the whole thing reverts and nothing moves. Test tokens are provided if you need
        them to settle.
      </p>

      {state.kind === 'error' && <Explain tone="bad">{state.message}</Explain>}
      {state.kind === 'done' && (
        <Explain tone="good">
          Rebalanced.{' '}
          <a
            href={EXPLORER_TX(state.signature)}
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
