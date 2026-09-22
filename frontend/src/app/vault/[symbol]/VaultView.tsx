'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IssuerSplit, type IssuerRow } from '@/components/IssuerSplit';
import { DevnetTrade } from '@/components/DevnetTrade';
import { Pill, Num, Explain, Skeleton, Card } from '@/components/ui';
import { Logo, LogoStack } from '@/components/Logo';
import { DEFAULTS, VAULTS, type Vault, type Wrapper } from '@/lib/vaults';
import { DEVNET, EXPLORER } from '@/lib/devnet';
import type { LiveLeg, LiveVault, OracleStatus } from '@/lib/live';
import { EXPLORER_TX } from '@/lib/wallet';

/**
 * The vault page. One page, showing the deployment that exists.
 *
 * There is no mainnet deployment, so there is nothing to show from mainnet
 * and no second page to put it on. Every figure here is read from the devnet
 * program: the vault's own status byte, the balance in each PDA-owned token
 * account, the live Scaled UI multiplier on each mint, the index supply, and
 * the Pyth price the vault actually reads. Addresses link to an explorer.
 *
 * The wrapper names are the real issuers', because the devnet mocks stand in
 * one for one and the basket is the point. Each row says which mock it is
 * and links to it, so nobody can mistake the two.
 */
export function VaultView({ vault }: { vault: Vault }) {
  const [live, setLive] = useState<LiveVault | null>(null);
  const [oracle, setOracle] = useState<OracleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await fetch('/api/devnet').then((r) => r.json());
        if (!alive) return;
        if (j.error) {
          setErr(j.error);
        } else {
          setLive((j.vaults as LiveVault[]).find((v) => v.symbol === vault.symbol) ?? null);
          setOracle(j.oracle ?? null);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const i = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [vault.symbol]);

  const config = DEVNET.vaults.find((v) => v.symbol === vault.symbol);

  /** Join the live leg to the mainnet registry entry it stands in for. */
  const registryFor = (leg: LiveLeg): Wrapper | undefined => {
    const key = config?.wrappers.find((w) => w.key === leg.key)?.mainnetKey;
    return vault.wrappers.find((w) => w.key === key);
  };

  const rows: IssuerRow[] =
    live?.legs.flatMap((leg) => {
      const wrapper = registryFor(leg);
      if (!wrapper) return [];
      // The premium comes from the holding's own liquidity pool: what the
      // market pays for one token against what one token entitles the vault
      // to. This is the only thing a market price is allowed to inform.
      // It never touches the vault's valuation.
      const soft = live?.config?.softDepegBps ?? 200;
      const hard = live?.config?.hardDepegBps ?? 500;
      const off = leg.premiumBps == null ? null : Math.abs(leg.premiumBps);
      const status =
        off == null ? 'ACTIVE' : off >= hard ? 'QUARANTINED' : off >= soft ? 'WATCH' : 'ACTIVE';
      return [
        {
          wrapper,
          weightBps: leg.weightBps,
          premiumBps: leg.premiumBps,
          priceSource: leg.priceSource,
          // Only an independent price is evidence of a depeg. A number from
          // our own pool is shown for information and never flags anything.
          status: (leg.priceSource === 'pyth' ? status : 'ACTIVE') as
            | 'ACTIVE'
            | 'WATCH'
            | 'QUARANTINED',
        },
      ];
    }) ?? [];

  const dark = vault.wrappers.filter((w) => !w.live);
  const paused = live != null && live.status !== 'ACTIVE';

  // A pull oracle is only as current as whoever last paid to write a price
  // down, so the age is stated as an age. What changes its meaning is who is
  // doing the writing: Pyth maintains its own devnet accounts continuously,
  // while one we posted stops moving the moment we stop running the script.
  const age = live?.priceAgeSeconds ?? null;
  const sponsored = live?.sponsored ?? false;
  const frozen = !sponsored && oracle != null && !oracle.refreshable;
  const ageTone = age == null ? 'neutral' : age < 600 ? 'good' : age < 3600 ? 'warn' : 'bad';

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-7 md:px-8">
      <div className="mb-6 flex flex-wrap gap-2">
        {VAULTS.map((v) => (
          <Link
            key={v.symbol}
            href={`/vault/${v.symbol}`}
            className={`mono rounded-[5px] border px-3 py-1.5 text-[11px] transition-colors ${
              v.symbol === vault.symbol
                ? 'border-interactive bg-raised text-ink'
                : 'border-hairline text-faint hover:text-dim'
            }`}
          >
            {v.symbol}
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_404px]">
        <div className="min-w-0 space-y-6">
          <header>
            <div className="label mb-2">{vault.underlying} · issuer-diversified vault</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <LogoStack
                wrapperKeys={vault.wrappers.filter((w) => w.live).map((w) => w.key)}
                size={46}
              />
              <h1 className="mono text-[28px] font-semibold text-ink">{vault.symbol}</h1>
              {live?.price != null ? (
                <span className="mono text-[40px] leading-none text-ink md:text-[44px]">
                  $
                  {live.price.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              ) : err ? (
                <span className="mono text-[20px] text-bad">price unavailable</span>
              ) : (
                <Skeleton w={200} h={40} />
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Pill tone="good" dot live>
                devnet
              </Pill>
              {live && (
                <Pill tone={paused ? 'warn' : 'good'} dot live={!paused}>
                  {live.status.replace('_', ' ')}
                </Pill>
              )}
              {age != null && (
                <Pill tone={ageTone} dot live={sponsored && ageTone === 'good'}>
                  Price {formatAge(age)} old
                </Pill>
              )}
              {sponsored && <Pill tone="good">Pyth-maintained</Pill>}
              {frozen && <Pill tone="warn">Not refreshing</Pill>}
              {live && (
                <Pill tone="neutral">
                  Supply {live.supply.toFixed(4)} {vault.symbol}
                </Pill>
              )}
            </div>

            <p className="mt-3 text-[12px] text-faint">
              {live?.feedLabel ?? `${vault.underlying}/USD`} from Pyth
              {' · '}1 {vault.symbol} = 1 {vault.unitLabel}
              {config && (
                <>
                  {' · '}
                  <a
                    href={EXPLORER(config.vault)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-dim hover:text-accent"
                  >
                    vault account ↗
                  </a>
                </>
              )}
            </p>
          </header>

          {frozen && (
            <Explain tone="warn">
              <b>Pricing is paused.</b> The last published price is{' '}
              {age != null ? formatAge(age) : 'some time'} old and is not currently
              updating. Deposits are priced against it, so they are held back until
              it refreshes. Withdrawals are unaffected and remain open.
            </Explain>
          )}

          {live?.standIn && (
            <Explain tone="warn">
              <b>Demo pricing.</b> This test deployment tracks a substitute price
              feed, so the dollar figure is illustrative. Everything else, the
              holdings, the weights and every safety limit, behaves exactly as it
              would in production.
            </Explain>
          )}

          {err && (
            <Explain tone="bad">
              Live data is temporarily unavailable. This usually clears within a few
              seconds.
            </Explain>
          )}

          <Card
            title="The basket, live"
            right={
              <span className="mono text-[10px] text-faint">
                {rows.length} issuer{rows.length === 1 ? '' : 's'}
              </span>
            }
          >
            {live ? <IssuerSplit rows={rows} dark={dark} /> : <Skeleton h={30} />}

            {live && (
              <table className="mt-5 w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-divider text-left">
                    <th className="label pb-2 font-normal">Holding</th>
                    <th className="label pb-2 text-right font-normal">Balance</th>
                    <th className="label pb-2 text-right font-normal">Per token</th>
                    <th className="label pb-2 text-right font-normal">Counted as</th>
                    <th className="label pb-2 text-right font-normal">Drift</th>
                  </tr>
                </thead>
                <tbody>
                  {live.legs.map((l) => (
                    <tr key={l.key} className="border-b border-divider/60 last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2.5">
                          <Logo wrapperKey={l.mainnetKey ?? l.key} size={22} />
                          <div className="text-ink">{l.standsFor}</div>
                        </div>
                        <a
                          href={EXPLORER(l.mint)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mono text-[11px] text-faint hover:text-accent"
                          title={l.mint}
                        >
                          {l.key} · {l.mint.slice(0, 4)}…{l.mint.slice(-4)} ↗
                        </a>
                      </td>
                      <td className="py-2.5 text-right">
                        <Num value={l.balance.toFixed(6)} />
                      </td>
                      <td className="py-2.5 text-right">
                        {l.multiplier === null ? (
                          <span className="mono text-[11px] text-faint">n/a</span>
                        ) : (
                          <Num value={l.multiplier.toFixed(9)} tone="good" />
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <Num value={l.units.toFixed(6)} />
                      </td>
                      <td className="py-2.5 text-right">
                        <Num
                          value={`${l.weightBps >= l.targetWeightBps ? '+' : ''}${(
                            (l.weightBps - l.targetWeightBps) / 100
                          ).toFixed(2)}pp`}
                          tone={l.weightBps > live.maxWeightBps ? 'bad' : 'neutral'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {live?.supplyIfRawRead != null && (
              <div className="mt-4">
                <Explain tone="good">
                  <b>Dividends are counted.</b> One of these holdings pays a yield that
                  accrues inside the token itself rather than arriving as a separate
                  payment, and it is easy to miss. {vault.symbol} counts it:{' '}
                  <Num value={live.supply.toFixed(6)} /> in issue against{' '}
                  <Num value={live.supplyIfRawRead.toFixed(6)} tone="bad" /> if it were
                  overlooked. Every holder would be short that difference.
                </Explain>
              </div>
            )}

            <div className="mt-3">
              <Explain tone="neutral">
                Premium is how far an issuer&apos;s token trades from the value of
                what it entitles the vault to. It never affects what your holding is
                worth: a vault holding a claim on an ounce of gold is worth an ounce of
                gold whatever any market says. A premium only signals that one issuer
                may have come loose from the asset behind it, which the vault checks on
                chain and acts on.{' '}
                <span className="text-dim">
                  A figure marked <sup className="mono text-[9px]">*</sup> comes from
                  this deployment&apos;s own liquidity, because no independent price is
                  published for that issuer. It is shown for information and never
                  flags anything; those issuers can only be suspended by hand.
                </span>
              </Explain>
            </div>
          </Card>

          <Card title="Weights and caps">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Stat
                label="Most one issuer may hold"
                value={`${((live?.maxWeightBps ?? DEFAULTS.maxWeightBps) / 100).toFixed(0)}%`}
                note="checked on every deposit"
              />
              <Stat
                label="Soft depeg"
                value={`${(DEFAULTS.softDepegBps / 100).toFixed(1)}%`}
                note={`held ${DEFAULTS.minDepegDurationSeconds / 60} min`}
              />
              <Stat
                label="Hard depeg"
                value={`${(DEFAULTS.hardDepegBps / 100).toFixed(1)}%`}
                note="immediate quarantine"
              />
              <Stat
                label="Price must be newer than"
                value={formatAge(devnetWindowSeconds)}
                note="one minute in production; wider here for a slower test feed"
              />
              <Stat
                label="Trading halts if value moves"
                value={`${(DEFAULTS.navBreakerBps / 100).toFixed(0)}%`}
                note="within 10 minutes"
              />
              <Stat
                label="Deposit / withdraw fee"
                value={`${(DEFAULTS.feeMintBps / 100).toFixed(2)}%`}
                note="each way; withdrawing in kind is free"
              />
            </dl>
          </Card>
        </div>

        <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          {config ? (
            <Card title="Deposit and withdraw">
              <DevnetTrade vault={config} live={live} />
            </Card>
          ) : (
            <Card title="Deposit and withdraw">
              <p className="text-[12.5px] text-faint">
                This vault is not in the devnet deployment record.
              </p>
            </Card>
          )}

          <Card title="Recent activity">
            <Activity vault={config?.vault ?? null} />
          </Card>
        </div>
      </div>
    </main>
  );
}

/** The window the devnet vaults are configured with. */
const devnetWindowSeconds = 3600;

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-divider pb-2">
      <dt className="text-[12.5px] text-faint">{label}</dt>
      <dd className="text-right">
        <Num value={value} className="text-[13px]" />
        {note && <div className="mono text-[10px] text-faint">{note}</div>}
      </dd>
    </div>
  );
}

interface ActivityEvent {
  signature: string;
  time: number | null;
  action: string;
  ok: boolean;
}

/** The vault's own transaction history, newest first. */
function Activity({ vault }: { vault: string | null }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);

  useEffect(() => {
    if (!vault) return;
    let alive = true;
    const load = async () => {
      try {
        const j = await fetch(`/api/activity?vault=${vault}`).then((r) => r.json());
        // An empty list from a failed read is not the same as no history, so
        // only replace what is shown when the read actually succeeded.
        if (alive && j.events && !j.error) setEvents(j.events);
      } catch {
        /* leave whatever was last shown */
      }
    };
    load();
    const i = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [vault]);

  if (!events) return <Skeleton h={80} />;
  if (events.length === 0) {
    return <p className="text-[12.5px] text-faint">No activity on this vault yet.</p>;
  }

  return (
    <ul className="space-y-0">
      {events.map((e) => (
        <li
          key={e.signature}
          className="flex items-baseline justify-between gap-3 border-b border-divider py-2 last:border-0"
        >
          <span className="min-w-0 text-[12.5px] text-body">
            {e.ok ? e.action : <span className="text-bad">{e.action} (failed)</span>}
          </span>
          <a
            href={EXPLORER_TX(e.signature)}
            target="_blank"
            rel="noreferrer noopener"
            className="mono shrink-0 text-[10.5px] text-faint hover:text-accent"
            title={e.signature}
          >
            {e.time ? timeAgo(e.time) : ''} &#8599;
          </a>
        </li>
      ))}
    </ul>
  );
}

function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
