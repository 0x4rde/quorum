'use client';

import { useState } from 'react';
import { Logo } from './Logo';

/**
 * How a basket is split between its issuers.
 *
 * Segments use the same neutral fills as the vault page's issuer bar, because
 * they are the same object and the site's rule is that colour is a claim
 * about safety: lime, amber and red carry meaning, nothing else does. A
 * blue/orange/green palette here said "these hues mean something" when they
 * only meant "index 0, 1, 2". Identity is carried where it already was — the
 * direct on-segment label and the logo'd legend row below.
 */
const SERIES = ['#39414A', '#2C333A', '#454E58'];

export interface Slice {
  key: string;
  /** The issuer's name, as a person would say it. */
  label: string;
  /** The wrapper key whose logo to show. */
  logoKey: string;
  weightBps: number;
  targetWeightBps: number;
  /** What the holding is, in tokens. */
  amount: number;
}

export function Composition({
  slices,
  capBps,
  height = 30,
}: {
  slices: Slice[];
  /** The most any one issuer may hold, drawn as a limit marker. */
  capBps: number;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((a, s) => a + s.weightBps, 0) || 1;

  return (
    <div>
      <div
        className="relative flex w-full overflow-hidden rounded-[5px]"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
      >
        {slices.map((s, i) => {
          const pct = (100 * s.weightBps) / total;
          return (
            <div
              key={s.key}
              onMouseEnter={() => setHover(i)}
              className="relative flex min-w-0 items-center justify-center transition-[filter] duration-150"
              style={{
                flexBasis: `${pct}%`,
                background: SERIES[i % SERIES.length],
                // A 2px surface gap between fills, not a border, so the
                // segment widths stay true to the data.
                marginLeft: i === 0 ? 0 : 2,
                filter: hover === i ? 'brightness(1.35)' : undefined,
              }}
            >
              {pct > 12 && (
                <span className="mono truncate px-2 text-[10.5px] text-[#B9C0C7]">
                  {pct.toFixed(0)}%
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-1.5">
        {slices.map((s, i) => {
          const pct = (100 * s.weightBps) / total;
          const drift = (s.weightBps - s.targetWeightBps) / 100;
          const nearCap = s.weightBps > capBps * 0.9;
          return (
            <div
              key={s.key}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="flex items-center gap-2.5 rounded-[4px] px-1 py-1 transition-colors"
              style={{ background: hover === i ? '#191D21' : undefined }}
            >
              <Logo wrapperKey={s.logoKey} size={18} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{s.label}</span>
              <span className="mono shrink-0 text-[12px] text-ink">{pct.toFixed(1)}%</span>
              <span
                className={`mono w-[62px] shrink-0 text-right text-[10.5px] ${
                  nearCap ? 'text-warn' : 'text-faint'
                }`}
                title={
                  nearCap
                    ? `Approaching the ${(capBps / 100).toFixed(0)}% limit for a single issuer`
                    : `Target ${(s.targetWeightBps / 100).toFixed(1)}%`
                }
              >
                {drift >= 0 ? '+' : ''}
                {drift.toFixed(1)}pp
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[10.5px] text-faint">
        Percentages are share of the basket. The right-hand figure is the gap from this
        issuer&apos;s target; no issuer may exceed {(capBps / 100).toFixed(0)}%.
      </p>
    </div>
  );
}
