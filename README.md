# Quorum: issuer-diversified RWA vaults on Solana

Every real-world asset on Solana is issued by several competing wrappers. xStocks,
Ondo and Backpack all tokenize the same SPY share; Paxos, Tether and Oro all
tokenize the same troy ounce. Each has its own liquidity, its own premium or
discount, its own dividend mechanics and its own way of failing. Today you have
to pick one, and you take all of that issuer's risk.

Quorum holds every major wrapper of one asset and issues a single token against
the whole basket, priced by oracle NAV rather than by any single pool.

The TradFi analogy is an insured cash sweep: banks spread a deposit across many
institutions so no single failure hurts you, mechanically and in the background.

**Live on devnet:** [quorum-pi-lilac.vercel.app](https://quorum-pi-lilac.vercel.app)
— connect a browser wallet, take some test USDC and mint. The protocol write-up,
with the arithmetic and the parameters, is at
[/docs](https://quorum-pi-lilac.vercel.app/docs).

**STOCKLANA hackathon build. Two internal audit passes, no external audit,
not deployed to mainnet. See [What is actually live](#what-is-actually-live).**

---

## The vaults

| Vault | Wrappers | Issuers | Worst leg on a $10k buy |
|---|---|---|---|
| **qGOLD** | PAXG + XAUt0 + Oro GOLD | Paxos, Tether, Oro | 0.51% |
| **qSPY** | SPYx + SPYon | xStocks, Ondo | 0.09% |
| **qMSTR** | MSTRx + MSTRbp | xStocks, Backpack | <0.01% |

These are not the vaults the spec started with. It proposed qNVDA / qSPY /
qGOLD with three wrappers each; measuring mainnet liquidity across all
thirteen underlyings where three issuers are simultaneously live gave a
different answer.

Ondo has real DEX liquidity in exactly one token: SPYon. Every other Ondo leg
is either unroutable or 35–97% price impact on a $2,000 trade, and NVDAon
prices a $500 buy at 72%. No three-issuer equity vault is possible at any
underlying, so qNVDA would have been a one-wrapper basket.

qGOLD is the only genuine three-issuer basket on Solana where every leg is
deep. qSPY and qMSTR use different issuer pairs, so all five issuers appear
across the three vaults, which tests that the registry is general better than
three identical baskets would.

---

## Architecture

```
programs/quorum/          Anchor program (the whole protocol)
  state.rs                Vault + WrapperConfig; the on-chain registry
  units.rs                invariant 5: balance → underlying units
  nav.rs                  invariant 1: NAV from oracle, never from a DEX
  oracle.rs               Pyth reads, staleness and confidence
  economics.rs            every token minted or paid out
  depeg.rs                spec §9.1 deviation test
  instructions/           18 instructions across 8 files

frontend/                 Next.js on Vercel; API routes proxy RPC + Jupiter
  src/app/docs/           the protocol write-up: the arithmetic, the guards,
                          the parameters and who may call what
  src/lib/pool.ts         dispatches between the two devnet venues
scripts/verify_wrappers.ts  Day-1 mainnet audit → docs/wrapper_audit.md
scripts/deploy_preflight.ts Pre-deploy checks, and the exact mainnet sequence
config/wrappers.ts        the registry, with provenance per address
config/devnet*.ts         the devnet fixture: mocks, feeds, pools
tests/                    litesvm integration, frontend parity, browser safety
docs/                     audit, open questions, design deltas
```

Mint and redeem settle in one transaction. There is no request queue and no
account to settle later, so no user action ever waits on a keeper. The keeper
only sweeps dividends and pushes multipliers; depeg and rebalance swaps are
permissionless.

---

## The seven invariants

These are correctness requirements, not preferences. Each one is enforced in
code and, where it can be, in a test.

**1. NAV never reads a DEX price.** `NAV = Σ(balance × units_per_token × (1 − haircut)) × oracle_price`.
A wrapper trading 3% below fair value does not make your token worth 3% less,
because the vault still holds the same claim on the same underlying. DEX prices exist
for exactly one purpose: detecting a depeg.

**2. Trust measured balance deltas, never quoted amounts.** Every swap reads the
vault's token account before and after. This applies even to in-kind deposits,
where there is no route and no slippage: PAXG carries a `TransferFeeConfig`
whose authority can raise it above zero whenever it likes.

**3. Both legs of every swap are checked against the registry**, never against
caller input. The same rule applies to *reads*: `compute_nav` iterates the
on-chain registry rather than the caller's account list, because omitting a
wrapper understates NAV, which understates `nav_per_token`, which makes the next
mint issue too many tokens. A dilution attack built out of a short account list.

**4. Every permissionless instruction is bounded.** The vault signs no route
anywhere in this program. `swap_depegged` and `rebalance` lend the source
tokens to the caller, who fills at any venue, and a settle in the same
transaction takes the proceeds back: the destination must clear its floor on
gross units so a haircut cannot hide a bad sale, the basket total must hold,
and the destination must stay inside its issuer cap. The loan does not commit
unless instruction introspection finds that settle below it. That is what
removes the operator dependency: there is no privileged keeper to go down,
because anyone can call these.

**5. xStocks balances are read as the Token-2022 Scaled UI Amount.** Reading the
raw balance silently undervalues NAV after every dividend. `units.rs` gives
callers no way to obtain a raw balance, and `register_wrapper` refuses any mint
whose extension set contradicts its declared multiplier source.

**6. The guardian can only restrict.** No instruction in this program lets the
guardian move, withdraw or redirect a token, no rescue function, no sweep.
Tightening is available to the guardian; loosening, in any direction, requires
the authority. Permissionless paths may only tighten, and may never touch a
wrapper the guardian has frozen.

**7. No user action waits on a keeper.** Mint and redeem each settle in one
transaction.

### Where the spec and the mints disagree

Spec §8 states that Ondo reinvests dividends as extra tokens with
`units_per_token` fixed at 1 and no multiplier. The mints say otherwise: both
Ondo mints carry a live `ScaledUiAmountConfig`, at 1.0017152 (NVDAon) and
1.0094731 (SPYon).

Registering them as the spec describes would understate NAV by 0.95% on SPYon
from the first deposit, drifting further with every dividend, with nothing
reverting. `register_wrapper` rejects the mismatch at registration rather than
trusting either document: it reads the mint's extensions and refuses a
declared `multiplier_source` that contradicts them.

---

## What is actually live

| | Status |
|---|---|
| Anchor program | **Live on devnet**, 107 tests pass, not on mainnet |
| In-kind mint / redeem | Tested end to end against a simulated chain |
| Guards, caps, breaker | Tested |
| Depeg defence | **Runs on devnet against live Pyth data**, and would on mainnet |
| Redemption-rate cross-check | **Runs**, catching a mint that disagrees with Pyth |
| Paying with any token | `[swap][mint_in_kind]` in one transaction; the program contains no exchange call |
| Buying a holding to deposit | **Works from the browser**, at two third-party venues, for every listed holding |
| `swap_depegged`, `rebalance` | **Executed end to end in tests**, venue stubbed by a token transfer |
| `swap_and_redeem` | Not implemented: in-kind redeem + a user-signed swap in one tx does the same with no vault signature |
| Frontend | **Deployed**, and mint / redeem work from a browser wallet against devnet |
| Wrapper addresses | All nine verified against their issuer |
| Deposits while a wrapper is impaired | Closed to everyone but the authority; redeem stays open |
| Bots / VPS | **Not built** |
| Devnet deployment | **Three vaults live, seeded, unpaused** |
| Mainnet deployment | **None** |

### The devnet deployment

Three vaults are live on devnet, seeded and unpaused, reading real Pyth
prices.

**<https://quorum-pi-lilac.vercel.app/vault/qGOLD>** is the deployment. Each
vault page reads its basket live off chain and you can mint and redeem there
with a browser wallet: connect Phantom, Solflare or Backpack, press "get test
USDC" for mock dollars and a little devnet SOL, then deposit. The panel picks
the holding that is furthest below its target weight, buys it at a public
pool and deposits it, in one transaction.
`npm run devnet:status` prints the same figures in a terminal, and
`npm run devnet:smoke -- --send` runs the whole browser path against a wallet
generated on the spot.

There is no separate devnet page. There is no mainnet deployment, so the vault
pages show the one that exists.

```
program   3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi
qGOLD     FwoZi5HiJTkVYUSZXhEgWwRYHHpHQA1T3jLrhkfLzFSm
qSPY      E7aV5ZRmA1YihC8oYTKdxozDxfwXhwMAFKkYS6VUNz8
qMSTR     DkVPasPUnsaRFiHGSzhKwrdjuyJrhNYxJHuB4aJevFvx
```

All addresses, including the seven mock mints, are in
[`config/devnet.json`](config/devnet.json).

**The oracle is real and live, and needs no API key.** Pyth maintains its own
sponsored price accounts on devnet shard 0 and refreshes them every few
minutes, `Metal.XAU/USD` included. Every vault reads those, so qGOLD prices
against the same feed it would use on mainnet, continuously, with no Hermes
access and no keeper of ours. `devnet:prices` checks for a sponsored
account first and only posts one itself for a feed nobody maintains.

That leaves the oracle staleness bound at one hour rather than the spec's 60
seconds, sized to the devnet publisher's slower cadence rather than to any
problem with the guard. Each vault page says how old its price is and whether
Pyth or we are the ones maintaining it. The program is not modified, feature-flagged or
stubbed for devnet, and every vault reads the feed it would read on mainnet:
`Metal.XAU/USD`, `Equity.US.SPY/USD` and `Equity.US.MSTR/USD`. The equity
feeds were stand-ins until Pyth granted them on 2026-09-22; devnet sponsors
no account for either, so those two are posted and refreshed by
`devnet:prices` rather than by Pyth. [`config/devnet_feeds.ts`](config/devnet_feeds.ts)
records which is which.

**The wrappers are mocks, and have to be.** The nine real ones are
issuer-controlled mainnet mints. Each mock reproduces the two things the
program actually reads off a mint, the owning token program and the presence
of a Scaled UI config, and `register_wrapper` rejects one whose extensions
contradict its declared multiplier source. What a mock cannot reproduce is
issuer behaviour: no freeze, no permanent-delegate clawback, no dividend.

**Invariant 5 is observable there, not just asserted.** qSPY holds mSPYx,
which carries a Scaled UI multiplier, alongside plain mSPYon. At the time of
writing the basket is 21.8292 raw tokens but 21.8898 SPY units, because
10.6052 raw mSPYx is worth 10.6658 units at a multiplier of 1.00571. Had NAV
read raw balances the basket would be short 0.0606 units, and every holder
short the dividend behind it. The vault page computes both figures live from
chain state, and `/docs` walks through the arithmetic.

**Deposits buy at a real venue we do not control.** Ten pools priced against
a mock dollar let a visitor arrive with nothing and leave holding an index
token. Seven are on the SPL Token Swap program; the two Scaled UI holdings
are on Raydium's CPMM, because the Token Swap build deployed on devnet takes
a single token program for the whole pool and rejects a Token-2022 mint.
Neither program is ours, which is the point: the vault signs no route, and
demonstrating that against somebody else's exchange proves more than
demonstrating it against one we wrote. `frontend/src/lib/pool.ts` dispatches
between them, so nothing above it knows there are two.

The pools are shallow on purpose and a large trade moves them a long way.
`npm run devnet:reprice` trades every one of them back in line with the vault
it feeds, because a pool priced differently from its vault is a standing
arbitrage rather than a cosmetic problem.

### Three things that would bite on mainnet today

**1. Three wrappers cannot be depeg-checked.** The defence runs, on devnet and
on mainnet, against live Pyth data. What it cannot do is judge a wrapper
nobody prices: Oro GOLD, Ondo SPYon and Backpack
MSTRbp publish no Pyth feed, so `swap_depegged` refuses to act on them and
they depend on the guardian quarantining by hand. Refusing to act when a
deviation cannot be proven is the right failure mode, but it is a gap, not a
feature.

Both sides of that comparison read Pyth's exponentially weighted average,
which ships inside every `PriceUpdateV2`, so the check needs no second oracle
and no account the transaction does not already carry. A Pyth `TwapUpdate`
would serve the same purpose and is not usable: the HTTP route returns 404
even on full institutional entitlement, and only two such accounts exist
across mainnet, both years stale.

**2. No transaction has ever been composed against a live aggregator.** The
program contains no CPI into a DEX, so there is nothing for litesvm to be
unable to simulate, and the permissionless swaps are covered end to end with
the venue stubbed. What is unproven is the client side: the frontend
composing `[Jupiter swap][mint_in_kind]` into one transaction that fits the
lock budget against a real quote.

**3. The Pyth access is a trial.** Every feed the project needs was granted on
2026-09-22 for a couple of weeks. The three underlyings and the four wrapper
feeds all resolve today; when the trial lapses, the equity feeds stop
refreshing, since devnet sponsors no account for them. Nothing breaks
silently: each vault page shows how old its price is and the staleness guard
refuses to trade on one past its window.

---

## Running it

```bash
# Program
cargo build-sbf                  # build
anchor build                     # build + IDL, and reports stack-frame overflows
cargo test -p quorum --lib       # 51 unit tests
npm test                         # 56 tests: litesvm integration, frontend parity

# Day-1 mainnet audit: read-only, no keys touched
npm run verify-wrappers          # → docs/wrapper_audit.md

# What a deploy would do, and whether it would work. Read-only.
npm run deploy-preflight         # devnet; CLUSTER=mainnet to check the other

# Devnet. Each prints a plan and spends nothing until --send.
npm run devnet:status            # read-only: baskets, weights, oracle age
npm run devnet:smoke  -- --send  # fresh wallet: faucet, mint, redeem
npm run devnet:mocks  -- --send  # create the seven mock wrapper mints
npm run devnet:prices -- --send  # post Pyth price accounts (refreshes in place)
npm run devnet:init   -- --send  # vaults, wrappers, seed, unpause
npm run devnet:demo   -- --send  # NAV, mint, redeem, permissionless rebalance
npm run devnet:faucet -- --send  # set up the faucet key the website uses
npm run devnet:pools  -- --send  # create the mUSDC liquidity pools
npm run devnet:reprice -- --send # trade every pool back in line with its vault
npm run devnet:sync              # copy the addresses into the frontend

# Frontend
cd frontend && npm run dev
```

`SOLANA_RPC_URL` is optional and defaults to the public endpoint, which is
heavily rate-limited. Set it for anything beyond a read.

### Toolchain note

`solana-cli 2.1.15` builds proc macros with cargo 1.79, which predates edition
2024, and a good part of the modern dependency graph has moved on. The lockfile
holds that subtree back and `programs/quorum/Cargo.toml` carries two
build-dependency pins. Build-time only; the on-chain binary is unaffected.
Upgrading the CLI is the durable fix.

---

## Docs

- [**The protocol write-up**](https://quorum-pi-lilac.vercel.app/docs): the
  accounting in closed form, the guards and their parameters, and the role
  matrix. Every formula cites the file it is implemented in and every number
  is read live off the deployment, which is why it is a page rather than a
  file that goes stale.
- [`docs/wrapper_audit.md`](docs/wrapper_audit.md): mainnet audit of all nine
  wrappers: token program, extensions, restriction surface, PDA-holdability.
- [`Quorum_Spec_v5.pdf`](Quorum_Spec_v5.pdf): the original specification. Read
  it with `pdftotext -layout`. The README says where the build departs from it.

## Program ID

```
3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi
```

Live on devnet, not on mainnet. Regulatory note: a token backed by a basket of securities
looks like a fund. Fine for a hackathon; needs legal review before any real
launch.

## Licence

MIT. See [`LICENSE`](LICENSE).
