'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

/**
 * Wallet connection, against the injected provider directly.
 *
 * No wallet-adapter. The adapter's value is breadth, dozens of wallets and a
 * modal, and it costs a large dependency tree plus a provider wrapper around
 * the whole app. Phantom, Solflare and Backpack all inject a provider at
 * `window.solana` implementing the same four methods used here, which covers
 * the wallets anyone demoing this will actually have. If that stops being
 * true the adapter is the answer, and this hook is the seam to replace.
 *
 * `signAndSendTransaction` is preferred over signing and sending separately:
 * the wallet picks its own RPC, which is nearly always better than the
 * public endpoint, and it keeps the send inside the wallet's own retry logic.
 */

interface Provider {
  isPhantom?: boolean;
  publicKey: { toBytes(): Uint8Array } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
  on?(event: string, handler: () => void): void;
  off?(event: string, handler: () => void): void;
}

function provider(): Provider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { solana?: Provider; backpack?: Provider };
  return w.solana ?? w.backpack ?? null;
}

export const EXPLORER_TX = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function useWallet() {
  const [pubkey, setPubkey] = useState<PublicKey | null>(null);
  const [available, setAvailable] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const p = provider();
    setAvailable(Boolean(p));
    if (!p) return;

    // Reconnect silently if this site was already approved, so a refresh
    // does not look like a logout.
    p.connect({ onlyIfTrusted: true })
      .then((r) => setPubkey(new PublicKey(r.publicKey.toBytes())))
      .catch(() => undefined);

    const onDisconnect = () => setPubkey(null);
    const onAccountChanged = () => {
      const k = provider()?.publicKey;
      setPubkey(k ? new PublicKey(k.toBytes()) : null);
    };
    p.on?.('disconnect', onDisconnect);
    p.on?.('accountChanged', onAccountChanged);
    return () => {
      p.off?.('disconnect', onDisconnect);
      p.off?.('accountChanged', onAccountChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    const p = provider();
    if (!p) {
      window.open('https://phantom.app/', '_blank', 'noopener');
      return;
    }
    setConnecting(true);
    try {
      const r = await p.connect();
      setPubkey(new PublicKey(r.publicKey.toBytes()));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await provider()?.disconnect();
    setPubkey(null);
  }, []);

  /**
   * Build, sign and send. Simulates first so a guard that would reject the
   * transaction is reported as a sentence before the wallet asks anyone to
   * sign something that cannot land.
   */
  const send = useCallback(
    async (conn: Connection, ixs: TransactionInstruction[]): Promise<string> => {
      const p = provider();
      if (!p || !pubkey) throw new Error('Wallet not connected.');

      const tx = new Transaction().add(...ixs);
      tx.feePayer = pubkey;
      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) throw new Error(explain(sim.value.logs ?? []));

      const { signature } = await p.signAndSendTransaction(tx);
      await conn.confirmTransaction(signature, 'confirmed');
      return signature;
    },
    [pubkey],
  );

  return { pubkey, available, connecting, connect, disconnect, send };
}

/**
 * Turn a simulation failure into a sentence.
 *
 * The program has around thirty-five error variants and none of them should
 * reach a user as a code. Anchor prints the variant name in the logs, so the
 * name is what gets translated; anything unrecognised falls back to the last
 * program log, which is still more use than `custom program error: 0x1782`.
 */
const MESSAGES: Record<string, string> = {
  IssuerCapExceeded:
    'That deposit would push this issuer past the vault\u2019s cap. Try a smaller amount, or deposit a different wrapper.',
  DestinationOverCap: 'That would push the destination wrapper past its cap.',
  OracleStale: 'The price feed is too old for this vault to trade on. Refresh the price and try again.',
  OracleConfidenceTooWide:
    'Pyth\u2019s publishers disagree on the price right now, so the vault is holding off.',
  OracleInvalidPrice: 'The price feed is returning something the vault will not trade on.',
  OracleFeedMismatch: 'That price account is for a different asset than this vault tracks.',
  VaultPaused: 'This vault is paused, so only the authority may deposit. In-kind redeem still works.',
  MarketClosed: 'The underlying market is closed. In-kind redeem still works.',
  VaultImpaired: 'A wrapper is impaired, so deposits are closed until the authority clears it.',
  NavCircuitBreaker: 'NAV moved too far too fast, so the vault stopped trading.',
  ZeroMintAmount: 'Enter an amount above zero.',
  SlippageExceeded: 'The amount of index tokens came out below your minimum.',
  WrapperMintDisabled: 'This wrapper is soft-depegged, so it is not accepting deposits.',
  WrapperQuarantined: 'This wrapper is quarantined. It still pays out on redeem.',
  WrapperFrozen: 'The issuer has frozen this leg, so it is skipped rather than blocking your exit.',
  WrapperNotActive: 'This wrapper is not active right now.',
  IncompleteWrapperAccounts: 'The page sent the wrong number of registry accounts. This is a bug, not your wallet.',
};


function explain(logs: string[]): string {
  for (const [code, message] of Object.entries(MESSAGES)) {
    if (logs.some((l) => l.includes(code))) return message;
  }
  const insufficient = logs.find((l) => l.includes('insufficient funds'));
  if (insufficient) return 'Not enough tokens or SOL in your wallet for that.';
  const last = [...logs].reverse().find((l) => l.startsWith('Program log:'));
  return last ? last.replace('Program log: ', '') : 'The transaction would fail.';
}
