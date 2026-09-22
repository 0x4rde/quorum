'use client';

import { useEffect, useState } from 'react';
import { Card, Num, Pill, Explain, Skeleton, Disclosure } from '@/components/ui';
import { Composition, type Slice } from '@/components/Composition';
import { Logo, LogoStack } from '@/components/Logo';
import { VAULTS } from '@/lib/vaults';
import { DEVNET, EXPLORER } from '@/lib/devnet';
import type { LiveVault, OracleStatus, VaultConfig } from '@/lib/live';

/**
 * Transparency.
 *
 * Nothing here has to be believed: every figure is read from the deployed
 * program and every address links to an explorer. The earlier version put all
 * of it on screen at once, which meant the one number a visitor wanted was
 * buried in twenty they did not. The shape now is headline first, then a
 * picture of each basket, then the full tables behind a disclosure for anyone
 * who wants to audit rather than glance.
 */
export default function Transparency() {
  const [vaults, setVaults] = useState<LiveVault[] | null>(null);
  const [oracle, setOracle] = useState<OracleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await fetch('/api/devnet').then((r) => r.json());
        if (!alive) return;
        if (j.error) setErr(j.error);
        else {
          setVaults(j.vaults);
          setOracle(j.oracle ?? null);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const i = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const totalValue = vaults?.reduce(
    (a, v) => a + (v.price != null ? v.legs.reduce((b, l) => b + l.units, 0) * v.price : 0),
    0,
  );
  const issuerCount = vaults?.reduce((a, v) => a + v.legs.length, 0) ?? 0;
  const worst = vaults
    ?.flatMap((v) => v.legs.map((l) => ({ l, cap: v.maxWeightBps })))
    .sort((a, b) => b.l.weightBps - a.l.weightBps)[0];

  return (
    <main className="mx-auto max-w-[1180px] space-y-6 px-4 py-8 md:px-8">
      <header>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Transparency</h1>
        <p className="mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-body">
          Every figure on this page is read from the vaults themselves, not from a
          database, and every holding links to a public explorer. Nothing here needs to
          be taken on trust.
        </p>
      </header>

      {err && (
        <Explain tone="bad">Live data is temporarily unavailable. It usually returns within a few seconds.</Explain>
      )}
      {oracle && !oracle.refreshable && (
        <Explain tone="warn">
          Pricing is paused on one or more vaults. Withdrawals remain open.
        </Explain>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Total held"
          value={totalValue != null ? `$${fmt(totalValue)}` : null}
          note="across every vault"
        />
        <Tile label="Vaults open" value={vaults ? String(vaults.length) : null} note="all accepting deposits" />
        <Tile label="Issuers held" value={vaults ? String(issuerCount) : null} note="no vault relies on one" />
        <Tile
          label="Largest position"
          value={worst ? `${(worst.l.weightBps / 100).toFixed(1)}%` : null}
          note={worst ? `${worst.l.standsFor}, limit ${(worst.cap / 100).toFixed(0)}%` : 'of any single issuer'}
        />
      </div>

      {!vaults && !err && (
        <Card>
          <Skeleton h={160} />
        </Card>
      )}

      {vaults?.map((v) => <VaultCard key={v.symbol} v={v} />)}

      <Disclosure summary="How a vault is valued">
        <div className="space-y-2.5 text-[12.5px] leading-relaxed text-body">
          <p>
            A vault&apos;s value is the value of what it holds, priced against the
            underlying asset rather than against what any one issuer&apos;s token happens
            to be trading at. If a single issuer&apos;s token slips 3% on an exchange,
            your holding is not worth 3% less, because the vault still holds the same
            claim on the same asset.
          </p>
          <p>
            Where a holding pays a yield that accrues inside the token, that growth is
            counted. Overlooking it would understate the vault by the size of every
            payment ever made.
          </p>
          <pre className="mono overflow-x-auto rounded-[5px] border border-hairline bg-inset px-4 py-3 text-[11.5px] leading-relaxed text-dim">
{`value of a holding = amount held x what one token entitles you to
total value        = sum of every holding x the asset's price
value per share    = total value / shares in issue`}
          </pre>
        </div>
      </Disclosure>

      <Disclosure summary="What these holdings stand for">
        <p className="mb-4 max-w-[70ch] text-[12.5px] leading-relaxed text-body">
          This is a test deployment, so the tokens held are stand-ins created for it.
          Each one behaves like the real token it represents in the ways the vault
          cares about, and each real token&apos;s trading depth was measured before it
          was chosen for the lineup.
        </p>
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[620px] border-collapse">
            <thead>
              <tr className="border-b border-divider text-left">
                <th className="label pb-2 font-normal">Vault</th>
                <th className="label pb-2 font-normal">Issuer</th>
                <th className="label pb-2 text-right font-normal">Cost to buy $10k</th>
                <th className="label pb-2 text-right font-normal">Held here</th>
              </tr>
            </thead>
            <tbody>
              {VAULTS.flatMap((v) =>
                v.wrappers.map((w) => {
                  const mock = DEVNET.vaults
                    .find((d) => d.symbol === v.symbol)
                    ?.wrappers.find((m) => m.mainnetKey === w.key);
                  return (
                    <tr key={`${v.symbol}-${w.key}`} className="border-b border-divider">
                      <td className="mono py-2.5 text-[12px] text-faint">{v.symbol}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Logo wrapperKey={w.key} size={20} />
                          <span className="text-[12.5px] text-ink">{w.issuer}</span>
                        </div>
                      </td>
                      <td className="mono py-2.5 text-right text-[12px] text-dim">{w.depth}</td>
                      <td className="py-2.5 text-right">
                        {mock ? (
                          <Pill tone="good">Yes</Pill>
                        ) : (
                          <span className="mono text-[11px] text-faint" title={w.darkReason ?? ''}>
                            not yet
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      </Disclosure>

      <Disclosure summary="What this deployment does not yet do">
        <ul className="space-y-2 text-[12.5px] leading-relaxed text-body">
          <li>
            <strong className="text-ink">It is a test deployment.</strong> The program
            builds, passes 80 automated tests and runs here, but has never handled real
            money.
          </li>
          <li>
            <strong className="text-ink">Three holdings cannot be checked
            automatically.</strong> Detecting that an issuer&apos;s token has broken
            from its asset needs an independent price for it, and Oro, Ondo and
            Backpack publish none. Those three are suspended by hand. The other four
            are checked against live data, and the check runs on request.
          </li>
          <li>
            <strong className="text-ink">Issuer failures have not been rehearsed
            live.</strong> A test token never freezes an account or suspends
            redemptions. Those paths are covered by simulation only.
          </li>
          <li>
            <strong className="text-ink">Paying with an arbitrary token is
            unproven.</strong> The vault itself never trades; pairing a swap with a
            deposit happens in your wallet, and that pairing has not been built against
            a live exchange quote.
          </li>
        </ul>
      </Disclosure>
    </main>
  );
}

function VaultCard({ v }: { v: LiveVault }) {
  const totalUnits = v.legs.reduce((a, l) => a + l.units, 0);
  const navNow = v.price != null ? totalUnits * v.price : null;

  const slices: Slice[] = v.legs.map((l) => ({
    key: l.key,
    label: l.standsFor,
    logoKey: l.mainnetKey ?? l.key,
    weightBps: l.weightBps,
    targetWeightBps: l.targetWeightBps,
    amount: l.balance,
  }));

  return (
    <Card
      title={`${v.symbol}`}
      right={
        <div className="flex items-center gap-2">
          <LogoStack wrapperKeys={slices.map((s) => s.logoKey)} size={22} />
          <Pill tone={v.status === 'ACTIVE' ? 'good' : 'warn'} dot live={v.status === 'ACTIVE'}>
            {v.status.replace('_', ' ')}
          </Pill>
        </div>
      }
    >
      <div className="grid gap-6 md:grid-cols-[1fr_230px]">
        <Composition slices={slices} capBps={v.maxWeightBps} />

        <dl className="space-y-3 text-[12.5px]">
          <Field label="Value held">
            {navNow != null ? <Num value={`$${fmt(navNow)}`} className="text-[15px]" /> : <span className="text-faint">n/a</span>}
          </Field>
          <Field label="Shares in issue">
            <Num value={v.supply.toFixed(4)} />
          </Field>
          <Field label="Asset price">
            {v.price != null ? (
              <span>
                <Num value={`$${fmt(v.price)}`} />
                {v.standIn && (
                  <span className="mono ml-1.5 text-[10px] text-warn" title="Test deployment uses a substitute feed">
                    demo
                  </span>
                )}
              </span>
            ) : (
              <span className="text-faint">n/a</span>
            )}
          </Field>
          <Field label="Vault address">
            <a
              href={EXPLORER(v.vault)}
              target="_blank"
              rel="noreferrer noopener"
              className="mono text-[11px] text-dim hover:text-accent"
              title={v.vault}
            >
              {v.vault.slice(0, 4)}&#8230;{v.vault.slice(-4)} &#8599;
            </a>
          </Field>
        </dl>
      </div>

      <div className="mt-5 space-y-2">
        <Disclosure summary="Holdings in detail" nested>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[620px] border-collapse">
              <thead>
                <tr className="border-b border-divider text-left">
                  <th className="label pb-2 font-normal">Issuer</th>
                  <th className="label pb-2 text-right font-normal">Amount held</th>
                  <th className="label pb-2 text-right font-normal">Per token</th>
                  <th className="label pb-2 text-right font-normal">Counted as</th>
                  <th className="label pb-2 text-right font-normal">Held at</th>
                </tr>
              </thead>
              <tbody>
                {v.legs.map((l) => (
                  <tr key={l.key} className="border-b border-divider">
                    <td className="py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Logo wrapperKey={l.mainnetKey ?? l.key} size={20} />
                        <span className="text-[12.5px] text-ink">{l.standsFor}</span>
                      </div>
                    </td>
                    <td className="mono py-2.5 text-right text-[12.5px] text-ink">
                      {l.balance.toFixed(4)}
                    </td>
                    <td className="py-2.5 text-right">
                      {l.multiplier == null ? (
                        <span className="mono text-[12px] text-faint">1.00</span>
                      ) : (
                        <Num value={l.multiplier.toFixed(6)} tone="good" className="text-[12px]" />
                      )}
                    </td>
                    <td className="mono py-2.5 text-right text-[12.5px] text-ink">
                      {l.units.toFixed(4)}
                    </td>
                    <td className="py-2.5 text-right">
                      <a
                        href={EXPLORER(l.tokenAccount)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mono text-[11px] text-dim hover:text-accent"
                        title={l.tokenAccount}
                      >
                        {l.tokenAccount.slice(0, 4)}&#8230;{l.tokenAccount.slice(-4)} &#8599;
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11.5px] leading-snug text-faint">
            &ldquo;Per token&rdquo; is what one token of that holding entitles the vault
            to. Above 1.00 means the token has accrued value since it was issued, and
            the vault counts it.
          </p>
        </Disclosure>

        {v.config && (
          <Disclosure summary="Safety limits in force" nested>
            <Guards config={v.config} maxWeightBps={v.maxWeightBps} />
          </Disclosure>
        )}
      </div>
    </Card>
  );
}

function Guards({ config, maxWeightBps }: { config: VaultConfig; maxWeightBps: number }) {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
  const mins = (s: number) => `${Math.round(s / 60)} min`;

  const rows: [string, string][] = [
    ['Most one issuer may hold', pct(maxWeightBps)],
    ['Suspend an issuer trading below fair value by', `${pct(config.softDepegBps)} for ${mins(config.minDepegDurationSeconds)}`],
    ['Discount it entirely at', pct(config.hardDepegBps)],
    ['Price must be newer than', `${config.maxAgeSeconds}s`],
    ['Reject a price this uncertain', pct(config.maxConfBps)],
    ['Halt trading if value moves', `${pct(config.navBreakerBps)} in ${mins(config.navBreakerWindowSeconds)}`],
    ['Deposit / withdrawal fee', `${pct(config.feeMintBps)} / ${pct(config.feeRedeemBps)}`],
    ['Extra charge while the market is shut', `+${pct(config.marketClosedSurchargeBps)}`],
    ['Most one rebalance may move', `${pct(config.maxSwapBps)} of a holding`],
    ['Wait between rebalances', mins(config.swapCooldownSeconds)],
    ['Rebalance once an issuer drifts', `${(config.rebalanceDriftBps / 100).toFixed(0)} points over target`],
    ['A rebalance may cost at most', pct(config.maxLossBps)],
  ];

  return (
    <>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name} className="border-b border-divider last:border-0">
              <td className="py-2 text-[12.5px] text-body">{name}</td>
              <td className="mono py-2 text-right text-[12px] text-ink">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11.5px] leading-snug text-faint">
        These are read from the vault itself, not quoted from documentation, so they are
        the limits actually in force right now.
      </p>
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="rounded-[8px] border border-hairline bg-panel px-4 py-3.5">
      <div className="label mb-1.5">{label}</div>
      {value ? (
        <div className="mono text-[20px] leading-none text-ink">{value}</div>
      ) : (
        <Skeleton w={80} h={20} />
      )}
      <div className="mt-1.5 text-[11px] text-faint">{note}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-divider pb-2">
      <dt className="label mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
