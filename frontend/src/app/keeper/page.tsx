'use client';

import { useEffect, useState } from 'react';
import { Card, Pill, Explain, Skeleton, Disclosure } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { RebalancePanel, findOpportunity } from '@/components/RebalancePanel';
import { DEVNET, comparesAgainstItself } from '@/lib/devnet';
import type { LiveVault } from '@/lib/live';

/**
 * Keeper page: the two instructions anyone may call, and what is claimable
 * right now.
 *
 * Everything documented here is an instruction the program actually exposes,
 * with its conditions read off the live vault account. The program contains
 * no call into any exchange, so there is no route argument and no exchange
 * account to describe; the permissionless paths are a loan and a settle.
 * Documenting an account list that does not exist is worse than documenting
 * nothing, because somebody may build against it.
 */
export default function Keeper() {
  const [vaults, setVaults] = useState<LiveVault[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const j = await fetch('/api/devnet').then((r) => r.json());
        if (alive && !j.error) setVaults(j.vaults);
      } catch {
        /* the opportunity panel simply stays quiet */
      }
    };
    load();
    const i = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  const config = vaults?.[0]?.config ?? null;
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_480px]">
        <div className="min-w-0 space-y-6">
          <header>
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink md:text-[32px]">
              The vault pays you to keep it honest.
            </h1>
            <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-body">
              Two paths are open to anyone, with no allowlist and no registration. They
              exist because an operator you have to trust is a worse design than one you
              do not need. If our bots stop, the vault can still be defended, by you.
            </p>
          </header>

          <Disclosure summary="How a permissionless swap works">
            <p className="mb-4 text-[13px] leading-relaxed text-body">
              The vault does not route your trade. It lends you the tokens and checks
              what comes back. One transaction, three or more instructions, and the
              program never learns where you filled.
            </p>
            <ol className="space-y-3 text-[12.5px] leading-relaxed text-body">
              <Step n="1" name="begin_rebalance or begin_swap_depegged">
                Proves the precondition, transfers the source tokens to your own
                account, writes a ticket recording what you owe, and proves by
                instruction introspection that a settle appears later in the same
                transaction. Nothing you pass is trusted: both legs are checked against
                the on-chain registry, and the amount lent is measured from the vault
                balance before and after.
              </Step>
              <Step n="2" name="anything you like">
                Sell what you borrowed and buy the destination wrapper, at any venue, in
                as many instructions as fit. Jupiter, a single pool, your own inventory,
                an OTC fill. The program does not see this part and does not care.
              </Step>
              <Step n="3" name="end_swap">
                Pulls the proceeds from your account and enforces the bounds: the
                destination leg must clear its floor on gross units, the basket total
                must hold, and the destination must stay inside its weight cap. If any
                check fails the whole transaction reverts, including the loan.
              </Step>
            </ol>
            <div className="mt-4">
              <Explain tone="good">
                The loan is safe to leave open because the settle is proven to exist
                before the tokens move, and the bounds are measured from balances rather
                than from anything you claim. A hostile fill cannot get past arithmetic,
                and a caller who simply disappears takes the whole transaction with them.
              </Explain>
            </div>
          </Disclosure>

          <Card
            title="begin_swap_depegged"
            right={<Pill tone="good" dot live>Callable now</Pill>}
          >
            <p className="mb-4 text-[13px] leading-relaxed text-body">
              When a wrapper trades away from fair value, sell the rich one and buy the
              cheap one. The spread lands in the basket and you keep a share of it.
            </p>
            <Disclosure summary="What the program checks" nested>
            {config ? (
              <Checks
                rows={[
                  ['Deviation at or past the soft threshold', pct(config.softDepegBps)],
                  ['Held that long', `${Math.round(config.minDepegDurationSeconds / 60)} min`],
                  ['Underlying oracle fresh and tight', `${config.maxAgeSeconds}s / ${pct(config.maxConfBps)}`],
                  ['You are selling the rich wrapper, not the cheap one', 'enforced'],
                  ['Both legs registered to this vault', 'enforced'],
                  ['Basket ends with more underlying units', `at least ${pct(config.minGainBps)}`],
                  ['Size capped per call', `${pct(config.maxSwapBps)} of the leg`],
                  ['Cooldown since the last call', `${Math.round(config.swapCooldownSeconds / 60)} min`],
                  ['Your cut of the realised gain', pct(config.callerRewardBps)],
                ]}
              />
            ) : (
              <Skeleton h={180} />
            )}
            </Disclosure>
            <div className="mt-4">
              <Explain tone="neutral">
                Both sides of the comparison use an averaged price rather than the
                latest tick, so a single block cannot manufacture a depeg and collect
                the reward for fixing it. Three of the holdings have no independent
                price published at all; those cannot be checked this way and are
                suspended by hand instead.
              </Explain>
            </div>
          </Card>

          <Card title="begin_rebalance" right={<Pill tone="good" dot live>Callable now</Pill>}>
            <p className="mb-4 text-[13px] leading-relaxed text-body">
              When one issuer drifts past its target weight, trade the basket back
              toward it. This one is allowed to cost a little, because crossing a spread
              to fix a real drift is worth a few basis points, but the ceiling is
              on-chain. It needs no wrapper feed and no TWAP, which is why it works
              today and the depeg path does not.
            </p>
            <Disclosure summary="What the program checks" nested>
            {config ? (
              <Checks
                rows={[
                  ['Source is over its target by at least', `${(config.rebalanceDriftBps / 100).toFixed(0)}pp`],
                  ['Destination is a registered, active wrapper', 'enforced'],
                  ['Destination stays inside its weight cap', 'enforced'],
                  ['Basket loses at most', pct(config.maxLossBps)],
                  ['Size capped per call', `${pct(config.maxSwapBps)} of the leg`],
                  ['Cooldown since the last call', `${Math.round(config.swapCooldownSeconds / 60)} min`],
                ]}
              />
            ) : (
              <Skeleton h={130} />
            )}
            </Disclosure>
          </Card>

          <Disclosure summary="Why permissionless">
            <p className="text-[13px] leading-relaxed text-body">
              A private keeper is a single point of failure wearing a uniform. If the
              only party who can defend the vault is us, then our VPS dying is the
              vault&apos;s problem, not ours. Because both paths are bounded by measured
              on-chain state rather than by who is calling them, opening them to the
              public is strictly better: it removes the dependency, and the vault gets
              defended the moment a leg slips, by whoever notices first.
            </p>
          </Disclosure>
        </div>

        <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <Opportunity vaults={vaults} />

        </div>
      </div>
    </main>
  );
}

/**
 * What is claimable right now, computed from the live baskets.
 *
 * Only the rebalance path can be evaluated: a depeg opportunity needs a
 * wrapper price, and there is none. Showing a blank depeg row is the honest
 * rendering of that.
 */
function Opportunity({ vaults }: { vaults: LiveVault[] | null }) {
  if (!vaults) {
    return (
      <Card title="Open right now">
        <Skeleton h={120} />
      </Card>
    );
  }

  const opportunity = findOpportunity(vaults);

  return (
    <Card
      title="Open right now"
      right={
        opportunity ? (
          <Pill tone="good" dot live>
            1 available
          </Pill>
        ) : (
          <Pill tone="neutral">Nothing to do</Pill>
        )
      }
    >
      <RebalancePanel opportunity={opportunity} />
      <Depegs vaults={vaults} />
    </Card>
  );
}

function Step({ n, name, children }: { n: string; name: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mono mt-0.5 h-5 w-5 shrink-0 rounded-[4px] bg-raised text-center text-[11px] leading-5 text-accent">
        {n}
      </span>
      <span>
        <span className="mono text-[12px] text-ink">{name}</span>
        <span className="mt-0.5 block">{children}</span>
      </span>
    </li>
  );
}

function Checks({ rows }: { rows: [string, string][] }) {
  return (
    <ul className="space-y-0">
      {rows.map(([check, value]) => (
        <li
          key={check}
          className="flex items-baseline justify-between gap-4 border-b border-divider py-2"
        >
          <span className="flex min-w-0 items-baseline gap-2.5 text-[12.5px] text-body">
            <span className="mono shrink-0 text-accent">&#10003;</span>
            <span>{check}</span>
          </span>
          <span className="mono shrink-0 text-[12px] text-dim">{value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Holdings trading away from what they entitle the vault to.
 *
 * The same comparison the on-chain check makes, shown before anyone pays to
 * make it: Pyth's averaged price for the issuer's token against the averaged
 * price of the asset behind it. Past the soft threshold the vault stops
 * accepting deposits of it; past the hard one it is discounted outright.
 */
function Depegs({ vaults }: { vaults: LiveVault[] }) {
  // A holding pointed at its own underlying reports zero deviation by
  // construction, so counting it among the ones that check out would be
  // claiming evidence that does not exist.
  const rows = vaults.flatMap((v) =>
    v.legs
      .filter(
        (l) =>
          l.premiumBps != null &&
          l.priceSource === 'pyth' &&
          !comparesAgainstItself(v.symbol, l.key),
      )
      .map((l) => ({
        vault: v.symbol,
        leg: l,
        off: Math.abs(l.premiumBps!),
        soft: v.config?.softDepegBps ?? 200,
        hard: v.config?.hardDepegBps ?? 500,
      })),
  );
  const flagged = rows.filter((r) => r.off >= r.soft).sort((a, b) => b.off - a.off);
  const checkable = rows.length;

  return (
    <div className="mt-3 border-t border-divider pt-3">
      <div className="label mb-2">Depegs</div>
      {flagged.length === 0 ? (
        <p className="text-[11.5px] leading-snug text-faint">
          {checkable > 0
            ? `All ${checkable} independently priced holdings are trading in line with
               the assets behind them, so there is nothing to arbitrage. The rest
               publish no price and cannot be checked this way.`
            : 'No holding has an independent price to check against right now.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {flagged.map((r) => (
            <li key={`${r.vault}-${r.leg.key}`} className="flex items-center gap-2.5">
              <Logo wrapperKey={r.leg.mainnetKey ?? r.leg.key} size={18} />
              <span className="flex-1 text-[12px] text-body">
                {r.leg.standsFor} in {r.vault}
              </span>
              <span
                className={`mono text-[12px] ${r.off >= r.hard ? 'text-bad' : 'text-warn'}`}
              >
                {r.leg.premiumBps! > 0 ? '+' : ''}
                {(r.leg.premiumBps! / 100).toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
