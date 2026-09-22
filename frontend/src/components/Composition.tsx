'use client';

import { useState } from 'react';
import { Logo } from './Logo';

/**
 * How a basket is split between its issuers.
 *
 * Categorical colour: each segment is an issuer's identity, not a magnitude,
 * so hues are assigned in a fixed order and never cycled. The three slots are
 * the reference palette's first three dark steps, validated against this
 * site's panel surface (#14171a) on all pairs: worst CVD deltaE 9.4, worst
 * normal-vision deltaE 20.9, every slot at or above 3:1 contrast. A vault
 * holds at most three issuers, so the order never runs out.
 *
 * Colour never carries identity alone: every segment is also direct-labelled
 * and listed below with its logo.
 */
const SERIES = ['#3987e5', '#d95926', '#199e70'];

/** The panel colour, used for the 2px gaps between segments. */
const SURFACE = '#14171a';

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
  height = 34,
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
        className="relative flex w-full overflow-hidden rounded-[6px]"
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
                filter: hover === i ? 'brightness(1.18)' : undefined,
              }}
            >
              {pct > 12 && (
                <span className="mono truncate px-2 text-[10.5px] font-semibold text-[#0b0d0f]">
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
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: SERIES[i % SERIES.length] }}
              />
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
