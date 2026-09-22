import { NextResponse } from 'next/server';
import { VAULTS } from '@/lib/vaults';

/**
 * RPC proxy for on-chain wrapper state.
 *
 * Reads each live wrapper's mint to report supply, decimals and, for
 * Token-2022 Scaled UI mints, the live multiplier. That multiplier is the
 * number invariant 5 exists to protect, so the Transparency page shows it
 * rather than asking anyone to take NAV on trust.
 *
 * The RPC URL stays server-side (spec §11b). Set SOLANA_RPC_URL in Vercel.
 */
export const revalidate = 0;

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

/** Scaled UI Amount config sits in the Token-2022 TLV after byte 166. */
function readScaledUiMultiplier(data: Buffer): number | null {
  if (data.length <= 166) return null;
  let o = 166;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    const body = o + 4;
    if (body + len > data.length) return null;
    if (type === 25) return data.readDoubleLE(body + 32); // ScaledUiAmountConfig
    o = body + len;
  }
  return null;
}

export async function GET() {
  const mints = VAULTS.flatMap((v) => v.wrappers.filter((w) => w.live).map((w) => w.mint));

  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
        params: [mints, { encoding: 'base64' }],
      }),
    });
    if (!r.ok) return NextResponse.json({ error: `rpc ${r.status}`, holdings: {} }, { status: 502 });

    const j = await r.json();
    const out: Record<string, { supply: string; decimals: number; multiplier: number | null }> = {};
    (j.result?.value ?? []).forEach((acc: { data: [string, string] } | null, i: number) => {
      if (!acc) return;
      const data = Buffer.from(acc.data[0], 'base64');
      out[mints[i]] = {
        supply: data.readBigUInt64LE(36).toString(),
        decimals: data.readUInt8(44),
        multiplier: readScaledUiMultiplier(data),
      };
    });
    return NextResponse.json({ holdings: out, fetchedAt: Math.floor(Date.now() / 1000) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, holdings: {} }, { status: 502 });
  }
}
