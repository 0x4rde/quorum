import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Recent activity on one vault.
 *
 * Reads the vault account's own transaction history and names each entry from
 * the instruction Anchor logs. Everything the panel needs is already on
 * chain, so it reports real signatures rather than explaining its own
 * absence.
 *
 * Deliberately shallow: six signatures and one batched lookup, two RPC round
 * trips. The naming pass is best-effort, because `getParsedTransactions` is
 * the call the public devnet endpoint rate-limits first. When it is refused
 * the entries still appear, unnamed, which is far better than an empty panel
 * implying the vault has never been touched.
 */
export const revalidate = 0;

const RPC = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';

/** Instruction names as Anchor logs them, in the words a holder would use. */
const ACTIONS: Record<string, string> = {
  MintInKind: 'Deposit',
  RedeemInKind: 'Withdrawal',
  UpdateNav: 'Valuation refreshed',
  BeginRebalance: 'Rebalance opened',
  BeginSwapDepegged: 'Depeg swap opened',
  EndSwap: 'Rebalance settled',
  RegisterWrapper: 'Issuer added',
  InitializeVault: 'Vault created',
  Unpause: 'Opened for deposits',
  Pause: 'Paused',
  SetWrapperStatus: 'Issuer status changed',
  UpdateVaultConfig: 'Settings changed',
  SetMarketClosed: 'Market hours changed',
  CheckDepeg: 'Depeg check',
  VerifyRedemptionRate: 'Rate cross-check',
};

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get('vault');
  if (!address) {
    return NextResponse.json({ error: 'missing vault' }, { status: 400 });
  }

  let vault: PublicKey;
  try {
    vault = new PublicKey(address);
  } catch {
    return NextResponse.json({ error: 'bad vault address' }, { status: 400 });
  }

  try {
    const conn = new Connection(RPC, 'confirmed');
    const sigs = await conn.getSignaturesForAddress(vault, { limit: 6 });
    if (sigs.length === 0) return NextResponse.json({ events: [] });

    let txs: Awaited<ReturnType<typeof conn.getParsedTransactions>> = [];
    try {
      txs = await conn.getParsedTransactions(
        sigs.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      );
    } catch {
      // Rate-limited. Fall through with no names rather than no history.
    }

    const events = sigs.map((s, i) => {
      const logs = txs[i]?.meta?.logMessages ?? [];
      // Every program logs its instruction name this way, so a deposit shows
      // the token program's inner MintTo after our own MintInKind. Keeping
      // only names we recognise drops the plumbing. The last survivor wins,
      // since begin_* is always followed by end_swap and the settle is what
      // characterises the pair.
      const names = logs
        .map((l) => /^Program log: Instruction: (\w+)/.exec(l)?.[1])
        .filter((n): n is string => typeof n === 'string' && n in ACTIONS);
      const name = names[names.length - 1];
      return {
        signature: s.signature,
        time: s.blockTime ?? null,
        action: name ? (ACTIONS[name] ?? name) : 'Transaction',
        ok: !s.err,
      };
    });

    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, events: [] }, { status: 502 });
  }
}
