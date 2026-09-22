import Link from 'next/link';
import { VAULTS } from '@/lib/vaults';
import { Pill } from '@/components/ui';
import { Logo } from '@/components/Logo';

export default function Landing() {
  return (
    <main className="mx-auto max-w-[1180px] px-4 md:px-8">
      <section className="grid items-start gap-10 py-14 md:grid-cols-[1fr_440px] md:py-20">
        <div>
          {/*
            Asset-neutral on purpose. Naming one asset in the headline ties it
            to whichever vault happens to lead the lineup, and the lineup is
            driven by measured DEX depth rather than by the copy.
          */}
          <h1 className="text-[40px] font-bold leading-[1.05] tracking-[-0.02em] text-ink md:text-[56px]">
            Every issuer.
            <br />
            One token.
            <br />
            Pick none of them.
          </h1>
          <p className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-body">
            Every real-world asset on Solana has several competing wrappers, each with
            its own liquidity, its own premium and its own way of failing. Quorum holds
            all of them and issues one token against the basket, priced by oracle NAV
            instead of by any single pool.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={`/vault/${VAULTS[0].symbol}`}
              className="rounded-[5px] bg-accent px-5 py-3 text-[13.5px] font-bold text-[#14171A] transition-colors hover:bg-accent-hover"
            >
              Open the vault
            </Link>
            <Link href="/transparency" className="text-[13.5px] text-dim transition-colors hover:text-accent">
              Inspect the holdings →
            </Link>
          </div>

          <div className="mt-10 flex flex-wrap gap-2">
            <Pill tone="good" dot>24/7 mint and redeem</Pill>
            <Pill tone="neutral">Issuer caps</Pill>
            <Pill tone="neutral">Automatic quarantine</Pill>
            <Pill tone="neutral">Exit always open</Pill>
          </div>
        </div>

        <div className="space-y-3">
          {VAULTS.map((v) => {
            const live = v.wrappers.filter((w) => w.live);
            return (
              <Link
                key={v.symbol}
                href={`/vault/${v.symbol}`}
                className="block rounded-[8px] border border-hairline bg-panel p-5 transition-colors hover:border-interactive"
              >
                <div className="flex items-baseline justify-between">
                  <span className="mono text-[15px] font-semibold text-ink">{v.symbol}</span>
                  <span className="mono text-[11px] text-faint">1 token = 1 {v.unitLabel}</span>
                </div>

                <div className="mt-3 flex items-center gap-1.5">
                  {live.map((w) => (
                    <Logo key={w.key} wrapperKey={w.key} size={24} />
                  ))}
                </div>

                <div className="mt-3 flex h-[8px] w-full gap-[2px] overflow-hidden rounded-[3px]">
                  {live.map((w, i) => (
                    <div
                      key={w.key}
                      style={{ flex: 1, background: i % 2 === 0 ? '#39414A' : '#2C333A' }}
                    />
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <span className="mono text-[11px] text-faint">
                    {live.length} wrapper{live.length === 1 ? '' : 's'} · 0 quarantined
                  </span>
                  <span className="mono text-[11px] text-dim">
                    worst leg {live.reduce((a, b) => (a.depth > b.depth ? a : b)).depth}
                  </span>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-snug text-faint">{v.blurb}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="border-t border-hairline py-14">
        <h2 className="label mb-6">What happens when an issuer depegs 2.1%</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-[8px] border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.04)] p-5">
            <div className="mono mb-3 text-[11px] uppercase tracking-[0.12em] text-bad">
              Holding that one wrapper
            </div>
            <div className="mb-4 h-[22px] rounded-[3px]" style={{ background: 'rgba(251,191,36,.75)' }} />
            <div className="mono mb-3 text-[26px] text-bad">−2.10%</div>
            <ul className="space-y-1.5 text-[12.5px] text-dim">
              <li>You hold 100% of the problem.</li>
              <li>No mechanism notices or reacts.</li>
              <li>Exiting means selling into the same broken pool.</li>
            </ul>
          </div>

          <div className="rounded-[8px] border border-[rgba(163,230,53,.25)] bg-[rgba(163,230,53,.04)] p-5">
            <div className="mono mb-3 text-[11px] uppercase tracking-[0.12em] text-accent">
              Holding the basket
            </div>
            <div className="mb-4 flex h-[22px] gap-[2px] overflow-hidden rounded-[3px]">
              <div style={{ flexBasis: '38%', background: '#39414A' }} />
              <div style={{ flexBasis: '34%', background: '#2C333A' }} />
              <div style={{ flexBasis: '28%', background: 'rgba(251,191,36,.75)' }} />
            </div>
            <div className="mono mb-3 text-[26px] text-accent">−0.59%</div>
            <ul className="space-y-1.5 text-[12.5px] text-dim">
              <li>+ The depeg is 28% of your exposure, not 100%.</li>
              <li>+ The wrapper stops accepting deposits automatically.</li>
              <li>+ Anyone can be paid to trade the vault back to fair value.</li>
              <li>+ In-kind redeem never closes.</li>
            </ul>
          </div>
        </div>
        <p className="mt-4 text-[12px] leading-snug text-faint">
          Illustrative, using a three-wrapper basket at equal-ish weights. Real vault
          weights and live premiums are on each vault page.
        </p>
      </section>

      <section className="border-t border-hairline py-14">
        <h2 className="label mb-6">How it works</h2>
        <div className="grid gap-4 md:grid-cols-4">
          {[
            ['01', 'Deposit anything', 'Pay with SOL or USDC and the swap runs inside the same transaction as the mint. Or deposit a wrapper directly, with no slippage at all.'],
            ['02', 'Priced by oracle', 'NAV is the basket valued at Pyth, never at a DEX. A pool moving does not move what your token is worth.'],
            ['03', 'Guards run on-chain', 'Issuer caps, oracle staleness, depeg quarantine and a NAV circuit breaker are all enforced by the program, not by us.'],
            ['04', 'Anyone can defend it', 'Depeg and rebalance swaps are permissionless and bounded. If our bots die, the vault still gets defended.'],
          ].map(([n, h, b]) => (
            <div key={n} className="rounded-[8px] border border-hairline bg-panel p-5">
              <div className="mono mb-2.5 text-[11px] text-accent">{n}</div>
              <div className="mb-2 text-[14px] font-semibold text-ink">{h}</div>
              <p className="text-[12.5px] leading-relaxed text-faint">{b}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
