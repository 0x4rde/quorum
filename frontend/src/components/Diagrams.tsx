'use client';

import React from 'react';
import { Logo } from './Logo';
import { DEVNET, comparesAgainstItself, isCpmm } from '@/lib/devnet';
import { bySymbol } from '@/lib/vaults';
import type { LiveLeg, LiveVault } from '@/lib/live';

/**
 * The diagrams on /docs.
 *
 * One rule governs all of them: no figure here is typed by hand. Every
 * number is read from `/api/devnet`, the same endpoint the vault pages read,
 * and every venue name is looked up in the deployment record. A protocol
 * whose first invariant is that it never trusts a quoted amount should not
 * document itself with quoted amounts, and a diagram carrying a number
 * somebody typed in September is a diagram that will be wrong in October.
 *
 * When the reading is unavailable the structure still renders and says the
 * figures are not loaded. That is the honest failure: the shape of the
 * mechanism is a fact about the program, the numbers are a fact about right
 * now, and only the second can go missing.
 *
 * On colour. This interface spends hue only on claims about safety: lime for
 * correct, amber and red for degrees of wrong. So the issuers inside a
 * basket are drawn in two neutral greys rather than given a colour each,
 * which is what a charting library would do. A reader should not be able to
 * mistake "this is Tether's slice" for "this slice is fine".
 */

const num = (n: number, dp: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Which exchange a holding is bought at, from the record rather than from memory. */
function venueFor(key: string): string | null {
  const pool = DEVNET.pools[`${key}-mUSDC`];
  if (!pool) return null;
  return isCpmm(pool) ? 'Raydium CPMM' : 'SPL Token Swap';
}

function Missing({ what }: { what: string }) {
  return (
    <p className="mono text-[11.5px] text-faint">
      {what} not loaded. The shape above is fixed by the program; the figures come
      from the chain and will appear when it answers.
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * 1. What a vault holds
 * ------------------------------------------------------------------ */

/**
 * Every issuer of one asset, sharing one bar.
 *
 * This is the whole product in a picture, so it opens the page. The bar is
 * live weight; the carets below it are where each boundary would sit if the
 * basket were exactly on target. The gap between the two is the drift the
 * rebalance path exists to close, which makes the diagram an argument rather
 * than an illustration.
 */
export function BasketBars({ vaults }: { vaults: LiveVault[] | null }) {
  if (!vaults) return <Missing what="Live weights" />;

  // `gap`, not `space-y`: the figures carry `m-0` to kill the browser's own
  // figure margin, and `space-y-*` works by setting margin-top on siblings,
  // so the two cancel and the rhythm collapses to nothing.
  return (
    <div className="flex flex-col gap-11">
      {vaults.map((v) => {
        const unit = bySymbol(v.symbol)?.unitLabel ?? 'unit';
        let cumulative = 0;
        const targets = v.legs.slice(0, -1).map((l) => {
          cumulative += l.targetWeightBps / 100;
          return cumulative;
        });

        return (
          <figure key={v.symbol} className="m-0">
            <figcaption className="mb-3">
              <span className="mono text-[15px] font-semibold text-ink">{v.symbol}</span>
              <span className="ml-3 text-[12.5px] text-faint">
                one token is a claim on one {unit}, spread across {v.legs.length} issuers
              </span>
            </figcaption>

            <div className="relative">
              <div className="flex h-[58px] w-full gap-[2px] overflow-hidden rounded-[5px]">
                {v.legs.map((l, i) => {
                  const drift = (l.weightBps - l.targetWeightBps) / 100;
                  return (
                    <div
                      key={l.key}
                      className="flex min-w-0 items-center gap-2.5 px-3"
                      style={{
                        flexGrow: Math.max(l.weightBps, 1),
                        flexBasis: 0,
                        background: i % 2 === 0 ? 'var(--color-seg-a)' : 'var(--color-seg-b)',
                      }}
                      title={`${l.standsFor}: ${(l.weightBps / 100).toFixed(2)}% of the basket, ${
                        drift >= 0 ? '+' : ''
                      }${drift.toFixed(2)}pp from target`}
                    >
                      <Logo wrapperKey={l.mainnetKey ?? l.key} size={24} />
                      <span className="hidden min-w-0 md:block">
                        <span className="block truncate text-[12.5px] leading-tight text-ink">
                          {l.standsFor}
                        </span>
                        <span className="mono block text-[11.5px] leading-tight text-dim">
                          {(l.weightBps / 100).toFixed(2)}%
                          <span className="ml-1.5 text-faint">
                            {drift >= 0 ? '+' : ''}
                            {drift.toFixed(2)}pp
                          </span>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Where each boundary belongs when the basket is on target. */}
              {targets.map((at, i) => (
                <span
                  key={i}
                  className="absolute top-full block h-[7px] w-px -translate-x-1/2 bg-accent"
                  style={{ left: `${at}%` }}
                  aria-hidden
                />
              ))}
            </div>

            {/* Narrow screens cannot fit the labels inside the segments. */}
            <ul className="mt-3 space-y-1 md:hidden">
              {v.legs.map((l) => {
                const drift = (l.weightBps - l.targetWeightBps) / 100;
                return (
                  <li key={l.key} className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate text-body">{l.standsFor}</span>
                    <span className="mono text-[12px] text-dim">
                      {(l.weightBps / 100).toFixed(2)}%
                    </span>
                    <span className="mono w-[58px] text-right text-[11.5px] text-faint">
                      {drift >= 0 ? '+' : ''}
                      {drift.toFixed(2)}pp
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        );
      })}

      <p className="max-w-[66ch] text-[11.5px] leading-relaxed text-faint">
        <span className="mr-1.5 inline-block h-[7px] w-px translate-y-[1px] bg-accent" /> marks
        where a boundary sits when the basket is exactly on target. The figure beside each
        issuer is how far it has drifted from there.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. How a balance becomes a price
 * ------------------------------------------------------------------ */

function Stage({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  const fg = tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-bad' : 'text-ink';
  const bd = tone === 'bad' ? 'border-[rgba(248,113,113,.3)]' : 'border-hairline';
  return (
    <div className={`min-w-0 flex-1 rounded-[6px] border ${bd} bg-panel px-3.5 py-3`}>
      <div className="label">{label}</div>
      <div className={`mono mt-1.5 truncate text-[15px] ${fg}`} title={value}>
        {value}
      </div>
      {note && <div className="mt-1 text-[11px] leading-snug text-faint">{note}</div>}
    </div>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono shrink-0 self-center px-1 text-[12px] text-faint sm:px-2">
      {children}
    </div>
  );
}

/**
 * One holding, from the balance the token program stores to the dollars the
 * vault counts, with the step that is easy to skip drawn in.
 *
 * Reading the raw balance instead of the Scaled UI amount is the single most
 * likely silent accounting bug in the design: nothing reverts, NAV is simply
 * low, and every holder is short the dividend behind the difference. Showing
 * both answers side by side is the only way to make a bug that produces no
 * error message visible.
 */
export function NavChain({ vaults }: { vaults: LiveVault[] | null }) {
  const vault = vaults?.find((v) => v.legs.some((l) => l.multiplier && l.multiplier !== 1));
  const leg = vault?.legs.find((l) => l.multiplier && l.multiplier !== 1);

  if (!vault || !leg || vault.price == null) return <Missing what="Live balances and price" />;

  const m = leg.multiplier!;
  const correct = leg.units * vault.price;
  const naive = leg.balance * vault.price;

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[12.5px] text-body">
        {vault.symbol} holds {leg.standsFor}, whose issuer pays dividends by raising a
        multiplier on the mint rather than by sending more tokens.
      </figcaption>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <Stage
          label="Balance on chain"
          value={num(leg.balance, 6)}
          note="what the token program stores"
        />
        <Operator>&times;</Operator>
        <Stage
          label="Scaled UI multiplier"
          value={num(m, 8)}
          note="read from the mint, set by the issuer"
        />
        <Operator>=</Operator>
        <Stage
          label={`${bySymbol(vault.symbol)?.unitLabel ?? 'unit'}s owed`}
          value={num(leg.units, 6)}
          tone="good"
          note="what the vault counts"
        />
        <Operator>&times;</Operator>
        <Stage
          label={vault.feedLabel}
          value={usd(vault.price)}
          note="Pyth, never a pool"
        />
        <Operator>=</Operator>
        <Stage label="Value in the basket" value={usd(correct)} tone="good" />
      </div>

      <div className="mt-4 max-w-[86ch] rounded-[6px] border border-[rgba(248,113,113,.28)] bg-[rgba(248,113,113,.05)] px-4 py-3">
        <p className="text-[12.5px] leading-relaxed text-body">
          Skip the multiplier and read {num(leg.balance, 6)} straight off the account, and
          this holding values at {usd(naive)} instead of {usd(correct)}. Nothing reverts.
          The vault is simply{' '}
          <span className="mono text-bad">{usd(correct - naive)}</span> short on this leg,
          and every deposit after that over-issues against it.
          {vault.supplyIfRawRead != null && (
            <>
              {' '}
              Across the whole vault the supply would read{' '}
              <span className="mono text-bad">{num(vault.supplyIfRawRead, 6)}</span> rather
              than <span className="mono text-accent">{num(vault.supply, 6)}</span>.
            </>
          )}
        </p>
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ *
 * 3 & 4. What a transaction looks like
 * ------------------------------------------------------------------ */

interface Instr {
  /** Program the instruction runs on. Null for the part we cannot see. */
  program: string | null;
  name: string;
  detail: string;
}

/**
 * The instructions in one transaction, drawn as one object because that is
 * what they are: the whole thing lands or none of it does.
 *
 * Numbered, because unlike most things a numbered list gets used for, this
 * genuinely is a sequence, and the order is the safety argument.
 */
function TxTrack({ steps, opaque }: { steps: Instr[]; opaque?: number }) {
  // The outer frame is the diagram's actual claim: these are not three
  // things that happen in order, they are one thing that either happens or
  // does not. Drawn as three loose cards it would say the opposite.
  return (
    <div className="rounded-[8px] border border-interactive bg-[rgba(255,255,255,.012)] p-3">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-0.5">
        <span className="label">One transaction</span>
        <span className="text-[11.5px] text-faint">
          all of it lands, or none of it does
        </span>
      </div>
      <ol className="m-0 grid list-none gap-2 p-0 lg:grid-cols-3">
        {steps.map((s, i) => {
          const hidden = opaque === i;
          return (
            <li
              key={s.name}
              className={`relative rounded-[6px] border px-3.5 py-3 ${
                hidden
                  ? 'border-dashed border-interactive bg-transparent'
                  : 'border-hairline bg-panel'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="mono text-[11px] text-faint">{i + 1}</span>
                <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {s.name}
                </span>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-body">{s.detail}</p>
              <p className="mono mt-2 text-[10.5px] text-faint">
                {s.program ?? 'not visible to the program'}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Buying a holding and depositing it, which is what the deposit button does. */
export function DepositTx({ vaults }: { vaults: LiveVault[] | null }) {
  // Name the venue the panel would actually use: the most underweight
  // holding that has a pool, in the vault the site leads with.
  const vault = vaults?.[0];
  const buyable = vault?.legs.filter((l) => venueFor(l.key));
  const target = buyable?.length
    ? [...buyable].sort(
        (a, b) => a.weightBps - a.targetWeightBps - (b.weightBps - b.targetWeightBps),
      )[0]
    : null;
  const venue = target ? venueFor(target.key) : null;

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[12.5px] text-body">
        The vault only ever accepts a holding it already recognises, never dollars. So the
        purchase happens first, beside the deposit rather than inside it.
      </figcaption>
      <TxTrack
        steps={[
          {
            program: 'Associated Token Account program',
            name: 'create the two accounts',
            detail:
              'Somewhere to receive the holding, and somewhere to receive the index token. Skipped silently if they exist.',
          },
          {
            program: venue ?? 'a public exchange',
            name: 'swap',
            detail: target
              ? `Test USDC buys ${target.standsFor}, chosen because it is furthest below its target weight.`
              : 'Test USDC buys whichever holding is furthest below its target weight.',
          },
          {
            program: 'Quorum',
            name: 'mint_in_kind',
            detail:
              'Reads the vault balance before and after the transfer and credits the difference, not the amount asked for.',
          },
        ]}
      />
      <p className="mt-3 max-w-[66ch] text-[12px] leading-relaxed text-faint">
        Quorum signs nothing at the exchange and never learns the route. It measures what
        arrived. That is why the program contains no call into any exchange at all, and why
        the same arrangement works with an aggregator on mainnet.
      </p>
    </figure>
  );
}

/** The permissionless path: lend, let the caller trade anywhere, then check. */
export function LoanSettleTx() {
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[12.5px] text-body">
        Anyone may rebalance a drifted basket or sell a holding that has come loose from
        its asset. The vault lends the tokens out and checks what returns.
      </figcaption>
      <TxTrack
        opaque={1}
        steps={[
          {
            program: 'Quorum',
            name: 'begin_rebalance',
            detail:
              'Checks the drift is real, hands you the source tokens, and proves by reading the transaction that a settle appears later in it.',
          },
          {
            program: null,
            name: 'anything you like',
            detail:
              'Fill at any venue, in as many instructions as fit. An aggregator, one pool, your own inventory.',
          },
          {
            program: 'Quorum',
            name: 'end_swap',
            detail:
              'Pulls the proceeds, then enforces the floor, the basket total and the weight cap. Any failure reverts the loan with it.',
          },
        ]}
      />
      <p className="mt-3 max-w-[66ch] text-[12px] leading-relaxed text-faint">
        The loan is safe to open because the settle is proven to exist before a token
        moves, and every bound is measured from balances rather than from anything the
        caller claims. A caller who walks away takes the whole transaction with them.
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------------ *
 * 5. What stops a bad holding
 * ------------------------------------------------------------------ */

/**
 * The depeg ladder, drawn against each holding's live distance from fair
 * value, so a reader can see how much room is left rather than only what the
 * thresholds are.
 */
export function DepegLadder({ vaults }: { vaults: LiveVault[] | null }) {
  if (!vaults) return <Missing what="Live prices" />;

  const rows = vaults.flatMap((v) =>
    v.legs
      .filter((l) => l.premiumBps != null)
      .map((l) => ({
        key: `${v.symbol}-${l.key}`,
        leg: l,
        off: Math.abs(l.premiumBps!),
        soft: v.config?.softDepegBps ?? 200,
        hard: v.config?.hardDepegBps ?? 500,
        selfReferential: comparesAgainstItself(v.symbol, l.key),
      })),
  );
  if (rows.length === 0) return <Missing what="Live prices" />;

  const hard = rows[0].hard;
  const soft = rows[0].soft;
  const scale = (bps: number) => Math.min(100, (bps / (hard * 1.4)) * 100);

  return (
    <figure className="m-0">
      <figcaption className="mb-3 max-w-[66ch] text-[12.5px] text-body">
        How far each holding is trading from what it entitles the vault to, against the two
        thresholds the program acts on.
      </figcaption>

      <div className="max-w-[760px] space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3">
            <span className="flex w-[150px] shrink-0 items-center gap-2 sm:w-[190px]">
              <Logo wrapperKey={r.leg.mainnetKey ?? r.leg.key} size={18} />
              <span
                className={`min-w-0 truncate text-[12.5px] ${
                  r.selfReferential ? 'text-faint' : 'text-body'
                }`}
              >
                {r.leg.standsFor}
              </span>
            </span>

            <span className="relative h-[8px] min-w-0 flex-1 rounded-[2px] bg-inset">
              {r.selfReferential ? (
                <span
                  className="absolute inset-y-0 left-0 rounded-[2px] border border-dashed border-interactive"
                  style={{ width: '9%' }}
                  title="no independent price; this compares the feed against itself"
                />
              ) : (
                <span
                  className={`absolute inset-y-0 left-0 rounded-[2px] ${
                    r.off >= r.hard ? 'bg-bad' : r.off >= r.soft ? 'bg-warn' : 'bg-seg-a'
                  }`}
                  style={{ width: `${Math.max(scale(r.off), 1.5)}%` }}
                />
              )}
              <span
                className="absolute inset-y-[-3px] w-px bg-warn opacity-70"
                style={{ left: `${scale(soft)}%` }}
                title={`stops accepting deposits at ${(soft / 100).toFixed(2)}%`}
              />
              <span
                className="absolute inset-y-[-3px] w-px bg-bad opacity-70"
                style={{ left: `${scale(hard)}%` }}
                title={`quarantined at ${(hard / 100).toFixed(2)}%`}
              />
            </span>

            <span
              className={`mono w-[74px] shrink-0 text-right text-[11.5px] ${
                r.selfReferential ? 'text-faint' : 'text-dim'
              }`}
            >
              {r.selfReferential ? 'no feed' : `${(r.off / 100).toFixed(2)}%`}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex max-w-[760px] flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-faint">
        <span>
          <span className="mr-1.5 inline-block h-[9px] w-px translate-y-[1px] bg-warn" />
          {(soft / 100).toFixed(1)}% held for a while: deposits of it stop
        </span>
        <span>
          <span className="mr-1.5 inline-block h-[9px] w-px translate-y-[1px] bg-bad" />
          {(hard / 100).toFixed(1)}%: quarantined, and it drops out of every swap
        </span>
        {rows.some((r) => r.selfReferential) && (
          <span>
            <span className="mr-1.5 inline-block h-[9px] w-[14px] translate-y-[2px] rounded-[2px] border border-dashed border-interactive" />
            issuer publishes no price of its own
          </span>
        )}
      </div>
    </figure>
  );
}

export type { LiveLeg };

/* ------------------------------------------------------------------ *
 * Technical apparatus
 * ------------------------------------------------------------------ */

/**
 * A display formula with the file it is taken from.
 *
 * The citation is not decoration. Every expression on this page exists in the
 * program, and a formula a reader cannot trace back to a line of Rust is a
 * claim about the protocol rather than a description of it. Set in the
 * monospace face because these are expressions over fixed-point integers, not
 * over the reals, and the difference matters throughout.
 */
export function Formula({
  children,
  source,
  note,
}: {
  children: React.ReactNode;
  source: string;
  note?: string;
}) {
  return (
    <figure className="m-0 my-5">
      <pre className="mono overflow-x-auto rounded-[6px] border border-hairline bg-inset px-4 py-3.5 text-[12.5px] leading-[1.75] text-ink">
        {children}
      </pre>
      <figcaption className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="mono text-[11px] text-faint">{source}</span>
        {note && <span className="text-[11.5px] text-faint">{note}</span>}
      </figcaption>
    </figure>
  );
}

/** A two-column definition list for constants and fields. */
export function Defs({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-5 gap-y-0">
      {rows.map(([term, def], i) => (
        <div key={term} className="contents">
          <dt
            className={`mono border-divider py-2 text-[12px] text-ink ${
              i === 0 ? '' : 'border-t'
            }`}
          >
            {term}
          </dt>
          <dd
            className={`m-0 border-divider py-2 text-[12.5px] leading-relaxed text-body ${
              i === 0 ? '' : 'border-t'
            }`}
          >
            {def}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Every tunable parameter, read from each vault account rather than restated
 * from the program's compiled defaults.
 *
 * `update_vault_config` can move any of these after deployment, so the
 * account is the only honest source. Three columns because the differences
 * between vaults are the interesting part: the weight cap is 40% where three
 * issuers exist and 60% where only two do, since two legs capped at 40%
 * cannot cover a basket.
 */
export function ParamTable({ vaults }: { vaults: LiveVault[] | null }) {
  if (!vaults || vaults.length === 0 || !vaults[0].config) {
    return <Missing what="Live vault parameters" />;
  }

  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const mins = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s}s`);

  const groups: {
    group: string;
    rows: { field: string; read: (v: LiveVault) => string; what: string }[];
  }[] = [
    {
      group: 'Issuance',
      rows: [
        { field: 'fee_mint_bps', read: (v) => pct(v.config!.feeMintBps), what: 'withheld from index tokens issued' },
        { field: 'fee_redeem_bps', read: (v) => pct(v.config!.feeRedeemBps), what: 'withheld from the burn before the pro-rata' },
        { field: 'market_closed_surcharge_bps', read: (v) => pct(v.config!.marketClosedSurchargeBps), what: 'added to the mint fee while the market is shut' },
        { field: 'max_weight_bps', read: (v) => pct(v.maxWeightBps), what: 'ceiling on any one issuer, enforced at mint and at settle' },
      ],
    },
    {
      group: 'Oracle',
      rows: [
        { field: 'max_age_seconds', read: (v) => `${v.config!.maxAgeSeconds}s`, what: 'a price older than this is refused' },
        { field: 'max_conf_bps', read: (v) => pct(v.config!.maxConfBps), what: 'ceiling on conf / price' },
      ],
    },
    {
      group: 'Circuit breaker',
      rows: [
        { field: 'nav_breaker_bps', read: (v) => pct(v.config!.navBreakerBps), what: 'move against the anchor that trips a pause' },
        { field: 'nav_breaker_window_seconds', read: (v) => mins(v.config!.navBreakerWindowSeconds), what: 'how long the anchor is held before re-seeding' },
      ],
    },
    {
      group: 'Depeg',
      rows: [
        { field: 'soft_depeg_bps', read: (v) => pct(v.config!.softDepegBps), what: 'deviation that starts the clock' },
        { field: 'min_depeg_duration_seconds', read: (v) => mins(v.config!.minDepegDurationSeconds), what: 'how long it must hold before MINT_DISABLED' },
        { field: 'hard_depeg_bps', read: (v) => pct(v.config!.hardDepegBps), what: 'quarantine at once, no persistence needed' },
      ],
    },
    {
      group: 'Permissionless swaps',
      rows: [
        { field: 'rebalance_drift_bps', read: (v) => `${(v.config!.rebalanceDriftBps / 100).toFixed(0)}pp`, what: 'how far over target the source must be' },
        { field: 'max_swap_bps', read: (v) => pct(v.config!.maxSwapBps), what: 'ceiling on one call, as a share of the source leg' },
        { field: 'swap_cooldown_seconds', read: (v) => mins(v.config!.swapCooldownSeconds), what: 'between permissionless swaps on one vault' },
        { field: 'min_gain_bps', read: (v) => pct(v.config!.minGainBps), what: 'floor on the depeg path: the basket must end ahead' },
        { field: 'max_loss_bps', read: (v) => pct(v.config!.maxLossBps), what: 'floor on the rebalance path: how much a trade may cost' },
        { field: 'caller_reward_bps', read: (v) => pct(v.config!.callerRewardBps), what: 'share of realised gain paid to the caller' },
      ],
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] table-fixed border-collapse text-left">
        {/*
          Fixed layout, not auto. Auto-layout treats the meaning column's
          sentences as a minimum width and pushes the table past the page
          rather than wrapping them, which hides the column that explains
          what every row means.
        */}
        <colgroup>
          <col style={{ width: '25%' }} />
          {vaults.map((v) => (
            <col key={v.symbol} style={{ width: `${34 / vaults.length}%` }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className="label border-b border-hairline pb-2 pr-4 font-normal">Field</th>
            {vaults.map((v) => (
              <th
                key={v.symbol}
                className="mono border-b border-hairline pb-2 pr-4 text-right text-[12px] font-semibold text-ink"
              >
                {v.symbol}
              </th>
            ))}
            <th className="label border-b border-hairline pb-2 font-normal">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <React.Fragment key={g.group}>
              <tr>
                <td colSpan={vaults.length + 2} className="pb-1 pt-5">
                  <span className="label">{g.group}</span>
                </td>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.field}>
                  <td className="mono border-t border-divider py-2 pr-4 align-top text-[12px] leading-snug text-body">
                    {r.field}
                  </td>
                  {vaults.map((v) => (
                    <td
                      key={v.symbol}
                      className="mono border-t border-divider py-2 pr-4 text-right align-top text-[12px] text-ink"
                    >
                      {r.read(v)}
                    </td>
                  ))}
                  <td className="border-t border-divider py-2 align-top text-[12px] leading-snug text-faint">
                    {r.what}
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The verdict `depeg::classify` returns, against the live thresholds.
 *
 * Drawn as a table rather than prose because it is a total function of four
 * inputs and the interesting part is the boundaries, particularly the one
 * that is easy to miss: a deviation that flips sign restarts the clock, so a
 * wrapper that swung rich then cheap has not been depegged for ten minutes,
 * it has had two different problems.
 */
export function DepegStates({ vaults }: { vaults: LiveVault[] | null }) {
  const c = vaults?.find((v) => v.config)?.config;
  const soft = c ? c.softDepegBps / 100 : 2;
  const hard = c ? c.hardDepegBps / 100 : 5;
  const hold = c ? Math.round(c.minDepegDurationSeconds / 60) : 10;

  const rows: [string, string, string][] = [
    [`|dev| < ${soft}%`, 'Healthy', 'Nothing. Deposits and swaps of this holding stay open.'],
    [
      `|dev| ≥ ${soft}%, clock under ${hold} min or direction flipped`,
      'Watching',
      'Record the timestamp and the sign. No effect on anything yet.',
    ],
    [
      `|dev| ≥ ${soft}% held ${hold} min in one direction`,
      'SoftDepeg',
      'Status becomes MINT_DISABLED. Deposits of it stop; begin_swap_depegged opens.',
    ],
    [
      `|dev| ≥ ${hard}%`,
      'HardDepeg',
      'Quarantined at once, no persistence required, and a NAV haircut applies.',
    ],
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-left">
        <colgroup>
          <col style={{ width: '36%' }} />
          <col style={{ width: '14%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className="label border-b border-hairline pb-2 pr-5 font-normal">Condition</th>
            <th className="label border-b border-hairline pb-2 pr-5 font-normal">Verdict</th>
            <th className="label border-b border-hairline pb-2 font-normal">Effect</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([cond, verdict, effect]) => (
            <tr key={verdict}>
              <td className="mono border-t border-divider py-2.5 pr-5 align-top text-[12px] text-body">
                {cond}
              </td>
              <td
                className={`mono border-t border-divider py-2.5 pr-5 align-top text-[12px] ${
                  verdict === 'Healthy'
                    ? 'text-accent'
                    : verdict === 'HardDepeg'
                      ? 'text-bad'
                      : verdict === 'SoftDepeg'
                        ? 'text-warn'
                        : 'text-dim'
                }`}
              >
                {verdict}
              </td>
              <td className="border-t border-divider py-2.5 align-top text-[12.5px] leading-snug text-body">
                {effect}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Who may do what.
 *
 * The important structural claim is that the guardian's column contains only
 * restrictions. `WrapperStatus::escalate` will move a holding up the severity
 * scale and refuses to move it down, and `unpause` is authority-only, so a
 * compromised guardian key can stop the vault and can never drain it or
 * quietly restore a holding it had impaired.
 */
export function RoleMatrix() {
  const rows: { action: string; authority: boolean; guardian: boolean; anyone: boolean }[] = [
    { action: 'mint_in_kind, redeem_in_kind', authority: true, guardian: true, anyone: true },
    { action: 'check_depeg, verify_redemption_rate', authority: true, guardian: true, anyone: true },
    { action: 'begin_rebalance, begin_swap_depegged, end_swap', authority: true, guardian: true, anyone: true },
    { action: 'update_nav', authority: true, guardian: true, anyone: true },
    { action: 'pause, set_market_closed', authority: true, guardian: true, anyone: false },
    { action: 'set_wrapper_status, upward only', authority: true, guardian: true, anyone: false },
    { action: 'unpause', authority: true, guardian: false, anyone: false },
    { action: 'set_wrapper_status, downward', authority: true, guardian: false, anyone: false },
    { action: 'update_vault_config', authority: true, guardian: false, anyone: false },
    { action: 'register_wrapper', authority: true, guardian: false, anyone: false },
    { action: 'set_authority, set_guardian', authority: true, guardian: false, anyone: false },
    { action: 'units_per_token move over 1%', authority: true, guardian: true, anyone: false },
  ];

  const Mark = ({ on, note }: { on: boolean; note?: string }) => (
    <span className={`mono text-[12px] ${on ? 'text-accent' : 'text-faint'}`} title={note}>
      {on ? '✓' : '·'}
    </span>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] table-fixed border-collapse text-left">
        <colgroup>
          <col style={{ width: '52%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className="label border-b border-hairline pb-2 pr-5 font-normal">Instruction</th>
            <th className="label border-b border-hairline pb-2 pr-5 text-center font-normal">
              Authority
            </th>
            <th className="label border-b border-hairline pb-2 pr-5 text-center font-normal">
              Guardian
            </th>
            <th className="label border-b border-hairline pb-2 text-center font-normal">Anyone</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.action}>
              <td className="mono border-t border-divider py-2 pr-5 text-[12px] text-body">
                {r.action}
              </td>
              <td className="border-t border-divider py-2 pr-5 text-center">
                <Mark on={r.authority} />
              </td>
              <td className="border-t border-divider py-2 pr-5 text-center">
                <Mark on={r.guardian} />
              </td>
              <td className="border-t border-divider py-2 text-center">
                <Mark on={r.anyone} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 max-w-[72ch] text-[12px] leading-relaxed text-faint">
        The last row is the only co-signature in the program: the authority may move a
        wrapper&apos;s <span className="mono">units_per_token</span> freely up to 1%, and
        past that the guardian must sign alongside. A larger move silently reprices every
        holder, so it is the one parameter change that is not a unilateral act.
      </p>
    </div>
  );
}
