'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Disclosure } from '@/components/ui';
import {
  BasketBars,
  Defs,
  DepegLadder,
  DepegStates,
  DepositTx,
  Formula,
  LoanSettleTx,
  NavChain,
  ParamTable,
  RoleMatrix,
} from '@/components/Diagrams';
import type { LiveVault } from '@/lib/live';

/**
 * Protocol documentation.
 *
 * Written for somebody who intends to check the claims: every formula names
 * the file it comes from, every parameter is read off the vault account
 * rather than restated from the program's compiled defaults, and every
 * quantity in the worked examples is live.
 *
 * It describes the protocol as it stands. It is not a changelog, and the
 * order things were built in is not a fact a reader needs.
 *
 * What is deliberately not here: the account layouts and the instruction
 * account orders. Those are generated into the IDL, and a hand-written copy
 * of them is a copy that will be wrong.
 */
export default function Docs() {
  const [vaults, setVaults] = useState<LiveVault[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/devnet')
      .then((r) => r.json())
      .then((j) => {
        if (alive && !j.error) setVaults(j.vaults);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-12 md:px-8 md:py-16">
      <header>
        <h1 className="max-w-[20ch] text-[32px] font-bold leading-[1.05] tracking-[-0.025em] text-ink md:text-[46px]">
          Issuer-diversified RWA vaults, in detail.
        </h1>
        <div className="mt-8 grid gap-x-12 gap-y-4 md:mt-10 md:grid-cols-2">
          <p className="max-w-[54ch] text-[14.5px] leading-relaxed text-body">
            Several issuers tokenize the same underlying asset. A Quorum vault holds a
            registry of them and issues one index token against the basket. Valuation is
            an oracle reading of the underlying multiplied by the units the basket is
            owed; no exchange price enters it. Deposits and redemptions are in kind and
            settle in one transaction.
          </p>
          <p className="max-w-[54ch] text-[14.5px] leading-relaxed text-body">
            The program is 18 instructions in about 4,800 lines of Rust. This page covers
            the accounting, the guards and their parameters, and who may call what. Every
            expression below cites the file it is implemented in, and every number is read
            live from the devnet deployment.
          </p>
        </div>
      </header>

      {/*
        The technical walkthrough. It lives here rather than on the landing
        page because this is the page somebody comes to for depth, and the
        shorter explainer already sits on the home page. Click to play: it
        carries a voiceover, and `preload="metadata"` keeps the file off the
        initial load for everyone who does not press play.
      */}
      <section className="mt-14 border-t border-divider pt-10 md:mt-20 md:pt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[21px] font-semibold tracking-[-0.01em] text-ink md:text-[24px]">
            The walkthrough
          </h2>
          <span className="mono text-[11px] text-faint">2:32</span>
        </div>
        <p className="mt-2.5 max-w-[78ch] text-[13.5px] leading-relaxed text-body">
          The same material as this page, in order: the unit accounting, the guards,
          and the reason the permissionless paths lend rather than sign a route.
        </p>
        <video
          className="mt-6 w-full rounded-[8px] border border-hairline bg-inset"
          controls
          preload="metadata"
          playsInline
          poster="/quorum-technical-poster.jpg"
        >
          <source src="/quorum-technical.mp4" type="video/mp4" />
          Your browser cannot play this video.{' '}
          <a href="/quorum-technical.mp4" className="text-accent underline">
            Download it instead
          </a>
          .
        </video>
      </section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="scales"
        title="Fixed-point scales"
        lead="There is no floating point anywhere in the accounting. Every quantity is a u128 at a declared scale, and the scales are not all the same."
      >
        <div className="max-w-[78ch]">
          <Defs
            rows={[
              ['UNIT_SCALE = 1e9', 'Scale of units_per_token. One unit is one share or one troy ounce.'],
              ['UNITS_SCALE = 1e9', 'Internal unit accounting, so quantities are nano-units.'],
              [
                'MULTIPLIER_SCALE = 1e18',
                <>
                  Scale of the Token-2022 Scaled UI multiplier. Deliberately wider than the
                  rest: the multiplier arrives as an f64 of 15 to 16 significant digits, and
                  at 1e9 the tail of a value like 1.0009180758 is truncated away. That tail
                  is a dividend.
                </>,
              ],
              ['PRICE_SCALE = 1e9', 'Oracle price, USD per unit.'],
              ['NAV_SCALE = 1e9', 'NAV and nav_per_token, USD.'],
              ['INDEX_DECIMALS = 9', 'Decimals of every index token, independent of any wrapper.'],
              ['BPS_DENOM = 10_000', 'Basis points denominator.'],
            ]}
          />
          <p className="mt-6 text-[13.5px] leading-relaxed text-body">
            Conversions round to nearest rather than truncating. Each step of the unit
            calculation divides, and truncating at every step biases valuation downward —
            the same direction as the accounting bug the module exists to prevent — so the
            error is kept unbiased instead. Rounding <em>against</em> the user is done
            separately, in the issuance and redemption paths, where it belongs.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="units"
        title="Unit accounting"
        lead="A wrapper's token balance is not the quantity it entitles the vault to. Three things sit between them, and one of them changes without warning."
      >
        <div className="max-w-[78ch]">
          <Formula
            source="programs/quorum/src/units.rs :: wrapper_units"
            note="mul_div_round at every step, never truncating"
          >
{`units_i = raw_balance_i / 10^decimals_i
        × scaled_ui_multiplier_i          (1e18 fixed point, live off the mint)
        × units_per_token_i               (1e9 fixed point, from the registry)`}
          </Formula>

          <p className="text-[13.5px] leading-relaxed text-body">
            The division is done stepwise rather than by multiplying all four terms and
            dividing once. Multiplying first overflows a u128 at realistic sizes: 1,000
            tokens at 9 decimals against a 1e18 multiplier is already about 1e39. Stepwise,
            the widest intermediate is roughly 1.8e37.
          </p>

          <h3 className="mt-8 text-[15px] font-semibold text-ink">
            Why the multiplier is the dangerous term
          </h3>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-body">
            Issuers pay dividends by two different mechanisms, and the program has to know
            which. xStocks raises a{' '}
            <span className="mono text-[12.5px]">ScaledUiAmountConfig</span> on the mint, so
            the stored balance is unchanged and the entitlement grows. Ondo mints additional
            tokens, so the balance itself grows and the multiplier stays at one. Reading the
            raw balance on an xStocks leg undervalues the basket, reverts nothing, and gets
            worse with every dividend.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Both directions are guarded at registration and on every read.{' '}
            <span className="mono text-[12.5px]">register_wrapper</span> rejects a mint whose
            extensions contradict its declared{' '}
            <span className="mono text-[12.5px]">multiplier_source</span>. A leg declared
            Scaled UI whose extension has since been removed errors rather than falling back
            to raw, and a leg declared Fixed that has <em>grown</em> an extension errors too.
            That second case is not hypothetical: the spec describes Ondo as fixed, and the
            mainnet mints carry a live config at 1.0017152 and 1.0094731.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            A scheduled multiplier takes effect at its own timestamp, so the read compares
            against <span className="mono text-[12.5px]">now</span> and picks the correct
            side of that boundary. Reading the wrong side is the same accounting bug, one
            tick early.
          </p>
        </div>

        <div className="mt-10">
          <NavChain vaults={vaults} />
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="nav"
        title="Net asset value"
        lead="NAV is a sum over the registry, never over what the caller passed. The risk here is completeness rather than arithmetic."
      >
        <div className="max-w-[78ch]">
          <Formula source="programs/quorum/src/nav.rs :: compute_nav">
{`gross_units   = Σ units_i
total_units   = Σ units_i × (1 − haircut_i / 10_000)
nav_total     = total_units × unit_price
nav_per_token = nav_total / index_supply`}
          </Formula>

          <p className="text-[13.5px] leading-relaxed text-body">
            The accounts making up that sum are supplied by the caller, and omitting one
            understates <span className="mono text-[12.5px]">total_units</span>, which
            understates <span className="mono text-[12.5px]">nav_per_token</span>, which
            makes the next deposit issue too many index tokens. So nothing iterates over the
            caller&apos;s list. <span className="mono text-[12.5px]">walk_registry</span>{' '}
            iterates over <span className="mono text-[12.5px]">vault.wrappers</span> and
            requires slot <span className="mono text-[12.5px]">i</span> of the registry to
            match position <span className="mono text-[12.5px]">i</span> of what was passed,
            re-deriving each config PDA rather than trusting the key given. A short,
            reordered, duplicated or substituted list fails.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Gross and net are both kept. The haircut is a valuation discount on an impaired
            holding, but the permissionless bounds compare on{' '}
            <span className="mono text-[12.5px]">gross</span>, so a quarantined
            wrapper&apos;s haircut cannot be used to disguise a sale below fair value. While
            any leg is impaired, NAV is a discounted number and non-authority deposits are
            refused, so nobody can buy the discount and hold it until the holding is
            restored.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="issuance"
        title="Issuance and redemption"
        lead="Fees are withheld into the basket rather than collected to an account. There is no fee destination in the program."
      >
        <div className="max-w-[78ch]">
          <Formula source="programs/quorum/src/economics.rs">
{`deposit:   gross = supply == 0
                     ? deposit_units × 10^9 / UNITS_SCALE      (bootstrap)
                     : deposit_value × 10^9 / nav_per_token    (priced at NAV)
           minted = gross × (10_000 − fee_mint_bps) / 10_000

redeem:    effective = burn × (10_000 − fee_redeem_bps) / 10_000
           out_i     = floor(vault_balance_i × effective / supply)`}
          </Formula>

          <p className="text-[13.5px] leading-relaxed text-body">
            The first deposit into an empty vault bootstraps the rate at one index token per
            unit of account. Every deposit after that prices against NAV, which is what
            keeps existing holders undiluted. The amount credited is the{' '}
            <em>measured</em> balance delta of the vault&apos;s token account, not the amount
            the caller asked to deposit — PAXG carries a transfer-fee config whose authority
            can raise it above zero at any time.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Redemption operates on raw balances deliberately. The Scaled UI multiplier
            applies equally to what the vault holds and to what the redeemer receives, so it
            cancels out of the ratio; applying it would be wrong twice. Every leg rounds
            down, which is what makes splitting one redemption into many strictly worse than
            doing it once. There is a test asserting exactly that.
          </p>

          <Disclosure summary="The round-trip property, and why it is not exactly (1 − f)²">
            <div className="max-w-[76ch] space-y-3 text-[13px] leading-relaxed text-body">
              <p>
                Deposit into an established vault and redeem immediately, and you get back
                slightly <em>more</em> than deposit × 0.999 × 0.999. That is correct rather
                than a leak. Because fees are withheld into the basket instead of collected,
                by the time you redeem you are a holder, and you claw back your own pool
                share of the fee you just paid.
              </p>
              <p>
                Two bounds are asserted. Returning more than the deposit would mean value
                leaked out of other holders; returning less than the naive figure would mean
                the fee was charged twice. The clawback is additionally required to be under
                a fiftieth of the fee paid, so depositing a large share of the vault cannot
                recover a meaningful part of your own fee. With fees set to zero the round
                trip must be value-neutral to within two base units, which isolates a
                genuine arithmetic leak from a fee effect.
              </p>
            </div>
          </Disclosure>
        </div>

        <div className="mt-10">
          <DepositTx vaults={vaults} />
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="weights"
        title="Weights and issuer caps"
        lead="Weight is measured in units, not in dollars, so it does not move when the underlying does."
      >
        <div className="max-w-[78ch]">
          <Formula source="programs/quorum/src/economics.rs :: weight_bps">
{`w_i = units_i × 10_000 / total_units

enforced at mint:    w_i after the deposit ≤ max_weight_bps
enforced at settle:  w_dest after the swap ≤ max_weight_bps`}
          </Formula>
          <p className="text-[13.5px] leading-relaxed text-body">
            The cap binds on the authority too once a vault is live. The single exemption is
            seeding: the first deposit into an empty vault is necessarily 100% of one issuer,
            so the check is skipped while supply is zero and binds on every deposit after.
          </p>
        </div>
        <div className="mt-10">
          <BasketBars vaults={vaults} />
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="oracle"
        title="Oracle guards"
        lead="Three conditions on every price read, and a fourth on the basket as a whole."
      >
        <div className="max-w-[78ch]">
          <Formula source="programs/quorum/src/oracle.rs">
{`staleness:   now − publish_time ≤ max_age_seconds
confidence:  conf / price × 10_000 ≤ max_conf_bps
sign:        price > 0

breaker:     |nav_per_token − anchor| / anchor × 10_000 > nav_breaker_bps
             where anchor is held for nav_breaker_window_seconds`}
          </Formula>
          <p className="text-[13.5px] leading-relaxed text-body">
            The breaker compares against a held anchor rather than against the previous
            observation. &ldquo;8% against a point up to ten minutes back&rdquo; catches a
            move delivered in five small steps; &ldquo;8% between adjacent calls&rdquo; does
            not, and there is a test that walks NAV down in increments to prove it. An
            anchor older than the window is re-seeded and the caller let through, because a
            quiet keeper must not block a user action.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Pyth&apos;s pull oracle exposes no trading-status field, which leaves staleness
            as the only available signal that a market has closed.
          </p>

          <Disclosure summary="Which averaged price the depeg check reads">
            <div className="max-w-[76ch] space-y-3 text-[13px] leading-relaxed text-body">
              <p>
                The comparison is made on Pyth&apos;s exponentially weighted average, not on
                a spot tick. A spot comparison would let a single sandwiched block
                manufacture a deviation and collect the reward for correcting it, so there is
                deliberately no spot reader on the depeg path at all.
              </p>
              <p>
                The EMA ships inside every{' '}
                <span className="mono text-[12.5px]">PriceUpdateV2</span>, in the same
                message as spot, so both sides of the comparison come from accounts the
                transaction already carries and no extra fetch or second oracle is involved.
                A Pyth <span className="mono text-[12.5px]">TwapUpdate</span> would serve the
                same purpose and is not usable: the HTTP route returns 404 even on full
                institutional entitlement, and only two such accounts exist across mainnet,
                both years stale.
              </p>
              <p>
                <span className="mono text-[12.5px]">twap_window_seconds</span> is a stored,
                settable, validated field on every vault that nothing reads. It is retained
                so the account layout does not move.
              </p>
            </div>
          </Disclosure>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="depeg"
        title="Depeg detection"
        lead="A deviation has to be provable from accounts the program reads itself, or the swap that acts on it cannot be left open to anyone."
      >
        <div className="max-w-[78ch]">
          <Formula source="programs/quorum/src/depeg.rs">
{`implied_i = wrapper_units(1 whole token) × unit_price    ← same path NAV uses
market_i  = Pyth EMA price of one wrapper token
dev_i     = (market_i / implied_i − 1) × 10_000           ← signed, in bps`}
          </Formula>
          <p className="text-[13.5px] leading-relaxed text-body">
            Fair value goes through{' '}
            <span className="mono text-[12.5px]">wrapper_units</span> rather than being
            computed separately, so the live multiplier is included on both sides. Without
            that, a wrapper trading exactly at fair value reads as rich by the whole
            multiplier — 94bps for SPYon today, which is most of the way to the soft
            threshold.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            The sign decides which trade is legal: sell the rich holding, buy the cheap one.{' '}
            <span className="mono text-[12.5px]">begin_swap_depegged</span> requires{' '}
            <span className="mono text-[12.5px]">dev_bps &gt; 0</span> on the source.
          </p>
        </div>

        <div className="mt-8">
          <DepegStates vaults={vaults} />
        </div>

        <div className="mt-10">
          <DepegLadder vaults={vaults} />
        </div>

        <div className="mt-8 max-w-[78ch]">
          <h3 className="text-[15px] font-semibold text-ink">
            The redemption-rate cross-check
          </h3>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-body">
            Reading the multiplier correctly is worth nothing if the multiplier itself is a
            lie, so <span className="mono text-[12.5px]">verify_redemption_rate</span>{' '}
            compares the mint&apos;s own Scaled UI value against the redemption rate Pyth
            publishes, and quarantines a mint that disagrees by more than{' '}
            <span className="mono text-[12.5px]">MAX_RR_DIVERGENCE_BPS = 50</span>.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Fifty rather than a round hundred, and the difference is the point: the failure
            it has to catch is a raw-balance read, which diverges by the wrapper&apos;s
            cumulative drift. That is 94bps for SPYon today, so a 100bps tolerance would
            catch it and a 150bps one would not — and the margin shrinks as a wrapper
            approaches its next dividend. The threshold is sized against the bug, not chosen
            for looking tidy.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="permissionless"
        title="Permissionless swaps"
        lead="Two paths anyone may call. Each is a loan and a settle, and the vault signs nothing at any exchange."
      >
        <div className="max-w-[78ch]">
          <p className="text-[13.5px] leading-relaxed text-body">
            The program contains no call into any exchange, and no instruction anywhere
            produces a vault signature over a route. The vault lends the source tokens to the
            caller&apos;s own account and requires the proceeds back in the same transaction.
            The alternative — signing a route directly — hands out a signature good for every
            vault-owned account that route names rather than only the declared leg, and then
            needs every leg re-measured and swept for leftover delegates afterwards. Lending
            removes that class of failure rather than bounding it, and it lets the caller
            fill anywhere.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            Atomicity alone does not make the loan safe, because a transaction containing
            only the loan still commits.{' '}
            <span className="mono text-[12.5px]">begin_swap</span> therefore proves by
            instruction introspection that a matching settle runs later in the same
            transaction, and records the index it must run at. The ticket PDA carries state
            and blocks a second concurrent loan; it is not the guarantee.
          </p>
        </div>

        <div className="mt-8">
          <LoanSettleTx />
        </div>

        <div className="mt-8 max-w-[78ch]">
          <Formula source="programs/quorum/src/instructions/permissionless_swap.rs :: end_swap">
{`floor      = units_sold × (10_000 + adjust_bps) / 10_000
             adjust_bps = +min_gain_bps   on the depeg path
             adjust_bps = −max_loss_bps   on the rebalance path

1.  dest_gained          ≥ floor                        ← on GROSS units
2.  total_gross_after    ≥ total_gross_before − sold + floor
3.  w_dest after         ≤ max_weight_bps
4.  source lost          ≤ what was lent

reward     = (dest_gained − sold) × unit_price / nav_per_token_before
             × caller_reward_bps / 10_000        ← depeg path only`}
          </Formula>

          <p className="text-[13.5px] leading-relaxed text-body">
            Bound 1 is measured on gross units so an impaired holding&apos;s haircut cannot
            make a bad fill look acceptable. Bound 2 is what catches units leaving some{' '}
            <em>other</em> leg: the loan left one leg and the floor came back into another,
            so a shortfall anywhere in the basket shows up in the total. Bound 3 exists
            because without it a caller could be paid to concentrate the basket into a single
            issuer.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-body">
            The reward is priced at the <em>open</em>, from{' '}
            <span className="mono text-[12.5px]">nav_per_token_before</span> and the unit
            price recorded on the ticket, so a caller cannot improve their own payout by
            choosing when to settle. It is paid only on the depeg path. Rebalancing is
            allowed to cost the basket up to{' '}
            <span className="mono text-[12.5px]">max_loss_bps</span>, because crossing a
            spread to correct a real drift is worth a few basis points, and paying a reward
            for a trade that is permitted to lose money would be paying twice.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="parameters"
        title="Parameters"
        lead="Read from each vault account, not from the program's compiled defaults. update_vault_config can move any of them after deployment, so the account is the only honest source."
      >
        <ParamTable vaults={vaults} />
        <div className="mt-6 max-w-[78ch] space-y-3 text-[13px] leading-relaxed text-body">
          <p>
            The weight cap differs by vault for a structural reason. The spec sets 4000bps,
            which assumes at least three issuers; two legs capped at 40% cover only 80% of a
            basket, so a two-issuer vault cannot satisfy it and uses 6000bps instead.
          </p>
          <p>
            <span className="mono text-[12.5px]">max_age_seconds</span> reads 3600 above
            against a spec default of 60, and that is a property of this deployment rather
            than of the program. Pyth&apos;s sponsored devnet accounts refresh every few
            minutes, so a 60-second bound would reject almost every read; the value is sized
            to the publisher&apos;s cadence. The guard is not disabled, weakened in code or
            feature-flagged — it is the same comparison against a different number, and it
            goes back to 60 on mainnet, where the publisher is sub-second. Each vault page
            states the age of the price it is quoting.
          </p>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="governance"
        title="Roles and key management"
        lead="Three principals: an authority multisig, a guardian hot key, and the public. The guardian's column contains only restrictions."
      >
        <RoleMatrix />

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">The status lattice</h3>
            <p className="mt-2.5 max-w-[56ch] text-[13.5px] leading-relaxed text-body">
              A wrapper is <span className="mono text-[12.5px]">ACTIVE</span>,{' '}
              <span className="mono text-[12.5px]">MINT_DISABLED</span>,{' '}
              <span className="mono text-[12.5px]">QUARANTINED</span> or{' '}
              <span className="mono text-[12.5px]">FROZEN</span>, ordered by severity.{' '}
              <span className="mono text-[12.5px]">escalate</span> moves a holding up that
              scale and refuses to move it down, so the guardian can impair a holding and
              can never restore one. Clearing an impairment is an authority act, as is
              unpausing a vault.
            </p>
            <p className="mt-3 max-w-[56ch] text-[13.5px] leading-relaxed text-body">
              The consequence worth stating plainly: a compromised guardian key can halt the
              protocol and cannot drain it. That asymmetry is the whole reason the role
              exists as a separate key at all.
            </p>
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Operational duties</h3>
            <p className="mt-2.5 max-w-[56ch] text-[13.5px] leading-relaxed text-body">
              No user action depends on an operator. Deposits and redemptions settle in one
              transaction, there are no request accounts and nothing to collect later. What
              a keeper does is sweep dividends, push multipliers for the issuers whose
              mechanism requires it, and refresh NAV; none of that gates a user.
            </p>
            <p className="mt-3 max-w-[56ch] text-[13.5px] leading-relaxed text-body">
              Redemption reads no oracle at all. That is what keeps the exit open on the
              worst day — a stale feed, a wide confidence interval or a closed market shuts
              the priced paths and leaves in-kind redemption working.
            </p>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------- */}
      <Section
        id="status"
        title="Verification status"
        lead="What has been executed, what has only been simulated, and what has not been done at all."
      >
        <div className="max-w-[78ch]">
          <Defs
            rows={[
              ['51 + 56 tests', 'Rust unit tests over the arithmetic, and litesvm integration tests over the instructions, plus parity tests asserting the frontend builds byte-identical instructions to the scripts.'],
              ['Devnet', 'Three vaults seeded and open. Deposits, redemptions, the depeg check, the redemption-rate check and a full loan-and-settle rebalance have all executed against live Pyth prices.'],
              ['Mainnet', 'Not deployed. No external audit; two internal passes with every finding and its status recorded.'],
              ['Wrappers', 'Mocks. The nine real ones are issuer-controlled mainnet mints, so a devnet copy reproduces what the program reads off a mint — token program and extension shape — and cannot reproduce a freeze, a permanent-delegate clawback or a real dividend.'],
              ['Aggregator', 'No transaction has ever been composed against a live aggregator. The program contains no exchange CPI, so nothing is left for litesvm to be unable to simulate; what is unproven is the client side fitting a real quote into the lock budget.'],
              ['Unpriced holdings', 'Oro, Ondo and Backpack publish no Pyth feed, so those three cannot be depeg-checked on chain and depend on the guardian acting by hand. Refusing to act on an unprovable deviation is the right failure mode and is still a gap.'],
            ]}
          />
          <p className="mt-6 text-[13.5px] leading-relaxed text-body">
            <Link
              href="/transparency"
              className="text-dim underline underline-offset-4 transition-colors hover:text-accent"
            >
              The transparency page
            </Link>{' '}
            shows the same deployment holding by holding with every address, and{' '}
            <Link
              href="/keeper"
              className="text-dim underline underline-offset-4 transition-colors hover:text-accent"
            >
              the keeper page
            </Link>{' '}
            shows what is claimable right now.
          </p>
        </div>
      </Section>
    </main>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-14 border-t border-divider pt-10 md:mt-20 md:pt-12">
      <h2 className="text-[21px] font-semibold tracking-[-0.01em] text-ink md:text-[24px]">
        {title}
      </h2>
      <p className="mt-2.5 max-w-[78ch] text-[13.5px] leading-relaxed text-body">{lead}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}
