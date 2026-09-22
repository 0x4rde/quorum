'use client';

import { ReactNode } from 'react';

/**
 * The shared vocabulary. Two product rules from the design handoff are
 * enforced here rather than left to each page:
 *
 *   1. Never show a number without a unit or a source.
 *   2. Warnings are plain language, never error codes.
 *
 * The program has ~35 error variants. None of them should ever reach a user.
 */

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  good: { fg: 'text-accent', bg: 'bg-[rgba(163,230,53,.08)]', bd: 'border-[rgba(163,230,53,.25)]' },
  warn: { fg: 'text-warn', bg: 'bg-[rgba(251,191,36,.08)]', bd: 'border-[rgba(251,191,36,.28)]' },
  bad: { fg: 'text-bad', bg: 'bg-[rgba(248,113,113,.08)]', bd: 'border-[rgba(248,113,113,.3)]' },
  neutral: { fg: 'text-dim', bg: 'bg-transparent', bd: 'border-hairline' },
};

export function Pill({
  tone = 'neutral', dot, live, children,
}: { tone?: Tone; dot?: boolean; live?: boolean; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span
      className={`mono inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-1 text-[10px] tracking-[0.12em] uppercase ${t.fg} ${t.bg} ${t.bd}`}
    >
      {dot && (
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'live-dot' : ''}`}
          style={{ background: 'currentColor' }}
        />
      )}
      {children}
    </span>
  );
}

/**
 * A number with its unit. `stale` dims it and explains itself on hover rather
 * than silently showing a value nobody should act on.
 */
export function Num({
  value, unit, tone = 'neutral', className = '', stale, staleReason, title,
}: {
  value: string; unit?: string; tone?: Tone; className?: string;
  stale?: boolean; staleReason?: string; title?: string;
}) {
  const colour =
    tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <span
      className={`mono ${stale ? 'stale' : colour} ${className}`}
      title={stale ? (staleReason ?? 'stale') : title}
    >
      {value}
      {unit && <span className="ml-1 text-faint">{unit}</span>}
    </span>
  );
}

/** Signed percentage, coloured by direction. Always carries its sign. */
export function Signed({ bps, className = '' }: { bps: number | null; className?: string }) {
  if (bps === null || Number.isNaN(bps)) return <span className="mono text-faint">n/a</span>;
  const pct = bps / 100;
  const tone: Tone = Math.abs(pct) < 0.005 ? 'neutral' : pct > 0 ? 'good' : 'bad';
  const sign = pct > 0 ? '+' : '';
  return <Num value={`${sign}${pct.toFixed(2)}%`} tone={tone} className={className} />;
}

export function Card({
  title, right, children, className = '',
}: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[8px] border border-hairline bg-panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-divider px-5 py-3.5">
          {title && <h2 className="label">{title}</h2>}
          {right}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * A section that opens on demand.
 *
 * The reason to have one at all is that these pages carry two audiences at
 * once. Somebody deciding whether to put money in needs four sentences;
 * somebody checking whether the thing is real needs the rule, the number and
 * the address. Printing both at full length serves neither, so the second
 * audience gets a disclosure and the first gets a page they can finish.
 *
 * `<details>` rather than state, so it works before hydration, survives
 * printing, and is findable with the browser's own search.
 */
export function Disclosure({
  summary,
  children,
  nested,
  defaultOpen,
}: {
  summary: string;
  children: ReactNode;
  nested?: boolean;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className={
        nested
          ? 'group rounded-[6px] border border-hairline bg-[rgba(255,255,255,.015)]'
          : 'group rounded-[8px] border border-hairline bg-panel'
      }
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[12.5px] text-body transition-colors hover:text-ink">
        <span className={nested ? 'label' : 'font-semibold text-ink'}>{summary}</span>
        <span className="mono text-[11px] text-faint transition-transform group-open:rotate-90">
          &#9656;
        </span>
      </summary>
      <div className="border-t border-divider px-4 py-4">{children}</div>
    </details>
  );
}

/**
 * Plain-language explanation strip. Takes a sentence, not a code.
 *
 * Example the design gives: "Backpack's token is trading 2.1% below fair
 * value, so the vault stopped buying it."
 */
export function Explain({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <p className={`rounded-[5px] border px-3.5 py-2.5 text-[12.5px] leading-relaxed ${t.bd} ${t.bg} ${tone === 'neutral' ? 'text-dim' : t.fg}`}>
      {children}
    </p>
  );
}

export function Skeleton({ w = '100%', h = 14 }: { w?: string | number; h?: number }) {
  return <span className="skeleton inline-block align-middle" style={{ width: w, height: h }} />;
}

/** Short address with a Solscan link. Never show a raw key without a way to check it. */
export function Addr({ value, className = '' }: { value: string; className?: string }) {
  return (
    <a
      href={`https://solscan.io/token/${value}`}
      target="_blank"
      rel="noreferrer noopener"
      className={`mono text-[11px] text-dim hover:text-accent ${className}`}
      title={value}
    >
      {value.slice(0, 4)}…{value.slice(-4)} <span className="text-faint">↗</span>
    </a>
  );
}

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="mono rounded-[5px] border border-interactive px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-dim transition-colors hover:border-accent hover:text-accent"
      onClick={(e) => {
        const el = e.currentTarget;
        navigator.clipboard?.writeText(text).then(
          () => {
            el.textContent = 'copied ✓';
            setTimeout(() => { el.textContent = label; }, 1500);
          },
          () => { el.textContent = 'copy failed'; },
        );
      }}
    >
      {label}
    </button>
  );
}
