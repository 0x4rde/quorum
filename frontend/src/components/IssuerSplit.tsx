'use client';

import { useState } from 'react';
import { Pill, Signed, Addr } from './ui';
import { Logo } from './Logo';
import type { Wrapper } from '@/lib/vaults';

export interface IssuerRow {
  wrapper: Wrapper;
  /** Basis points of the basket. */
  weightBps: number;
  /** Premium/discount to oracle fair value, in bps. Null when unmeasurable. */
  premiumBps: number | null;
  /**
   * Where that premium came from.
   *
   * `pyth` is an independent market price published by Pyth, and is what the
   * on-chain depeg check reads. `pool` is this deployment's own liquidity,
   * used where the issuer publishes no feed: it is a real price but not
   * independent evidence, since we seeded it and we are most of its volume.
   * Rendering the two identically would imply a check that is not happening.
   */
  priceSource?: 'pyth' | 'pool' | null;
  status: 'ACTIVE' | 'WATCH' | 'QUARANTINED';
}

const HATCH =
  'repeating-linear-gradient(45deg,#B44444,#B44444 5px,#7E2C2C 5px,#7E2C2C 10px)';

/**
 * The signature component: one stacked bar, one segment per live issuer.
 *
 * Note it renders `rows.length` segments rather than assuming three. Two of
 * the three vaults hold two wrappers, since Backpack's SPY and Ondo's MSTR
 * are provisioned but not tradeable, and a bar hard-coded to thirds would either
 * lie about the basket or break.
 *
 * Hovering a segment brightens it and highlights its row, so the bar and the
 * table read as one object rather than two views of the same data.
 */
export function IssuerSplit({ rows, dark }: { rows: IssuerRow[]; dark: Wrapper[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const segFill = (r: IssuerRow, i: number) => {
    if (r.status === 'QUARANTINED') return HATCH;
    if (r.status === 'WATCH') return 'rgba(251,191,36,.75)';
    return i % 2 === 0 ? '#39414A' : '#2C333A';
  };

  return (
    <div>
      <div className="flex h-[30px] w-full gap-[2px] overflow-hidden rounded-[5px]">
        {rows.map((r, i) => (
          <div
            key={r.wrapper.key}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="flex min-w-0 items-center justify-center transition-[filter] duration-150"
            style={{
              flexBasis: `${r.weightBps / 100}%`,
              background: segFill(r, i),
              filter: hover === i ? 'brightness(1.35)' : undefined,
            }}
            title={`${r.wrapper.issuer} · ${(r.weightBps / 100).toFixed(1)}%`}
          >
            <span className="flex min-w-0 items-center gap-1.5 px-2">
              <Logo wrapperKey={r.wrapper.key} size={14} />
              <span
                className={`mono truncate text-[10px] tracking-[0.1em] uppercase ${
                  r.status === 'WATCH' ? 'text-[#14171A]' : 'text-[#B9C0C7]'
                }`}
              >
                {r.wrapper.issuer}
              </span>
            </span>
          </div>
        ))}
      </div>

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="border-b border-divider text-left">
            <th className="label pb-2 font-normal">Issuer</th>
            <th className="label pb-2 text-right font-normal">Weight</th>
            <th className="label pb-2 text-right font-normal">Premium</th>
            <th className="label pb-2 text-right font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.wrapper.key}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="border-b border-divider transition-colors"
              style={{ background: hover === i ? '#191D21' : undefined }}
            >
              <td className="py-2.5">
                <div className="flex items-center gap-2.5">
                  <Logo wrapperKey={r.wrapper.key} size={22} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-ink">{r.wrapper.issuer}</div>
                    <div className="mono truncate text-[10px] text-faint">{r.wrapper.key}</div>
                  </div>
                </div>
              </td>
              <td className="mono py-2.5 text-right text-[13px] text-ink">
                {(r.weightBps / 100).toFixed(1)}%
              </td>
              <td className="py-2.5 text-right text-[13px]">
                {r.priceSource === 'pool' && r.premiumBps !== null ? (
                  <span
                    title="From this deployment's own pool. No independent price is published for this issuer, so the vault cannot check it for a depeg on chain."
                  >
                    <Signed bps={r.premiumBps} className="text-[13px]" />
                    <sup className="mono ml-0.5 text-[9px] text-faint">*</sup>
                  </span>
                ) : r.premiumBps === null ? (
                  <span
                    className="mono stale text-[12px]"
                    title="No Pyth feed publishes a market price for this wrapper, so its premium cannot be proven on-chain."
                  >
                    no feed
                  </span>
                ) : (
                  <Signed bps={r.premiumBps} className="text-[13px]" />
                )}
              </td>
              <td className="py-2.5 text-right">
                <Pill tone={r.status === 'ACTIVE' ? 'good' : r.status === 'WATCH' ? 'warn' : 'bad'}>
                  {r.status === 'ACTIVE' ? 'OK' : r.status === 'WATCH' ? 'WATCH' : 'QUAR'}
                </Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {dark.length > 0 && (
        <div className="mt-4 rounded-[5px] border border-hairline bg-[#0F1214] px-3.5 py-3">
          <div className="label mb-2">Registered but not held</div>
          {dark.map((w) => (
            <div key={w.key} className="flex items-start justify-between gap-4 py-1">
              <div className="min-w-0">
                <span className="text-[12.5px] text-dim">{w.issuer}</span>{' '}
                <span className="mono text-[11px] text-faint">{w.key}</span>
                <p className="mt-0.5 text-[12px] leading-snug text-faint">{w.darkReason}</p>
              </div>
              <Addr value={w.mint} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
