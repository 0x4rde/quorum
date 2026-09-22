# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

Issuer-diversified RWA vaults on Solana. Each vault holds every major tokenized
wrapper of one real-world asset and issues a single index token against the
basket, priced by oracle NAV rather than by any pool.

| Vault | Wrappers | Unit of account | Issuer cap |
|---|---|---|---|
| `qSPY` | xStocks SPYx, Ondo SPYon | 1 SPY share | 6000bps |
| `qMSTR` | xStocks MSTRx, Backpack MSTRbp | 1 MSTR share | 6000bps |
| `qGOLD` | Paxos PAXG, Tether XAUt0, Oro GOLD | 1 troy ounce | 4000bps |

The lineup was chosen on measured DEX depth rather than the spec's original
list; the README says why. A two-issuer vault cannot satisfy a 4000bps cap,
which is why those two are 6000.

## Status

Live on devnet, seeded and unpaused, reading real Pyth feeds. **Not deployed to
mainnet.** `config/devnet.json` holds every address, `npm run devnet:status`
prints the live baskets, and the frontend is at
<https://quorum-pi-lilac.vercel.app>, where mint and redeem work from a browser
wallet. The protocol write-up is at `/docs` on that site.

Devnet reads Pyth's sponsored accounts on shard 0 where they exist, which need
no API key. The equity feeds have no sponsored account, so `devnet:prices`
posts and refreshes them.

## Layout

```
programs/quorum/src/    the program: 18 instructions
  state.rs              Vault + WrapperConfig, the on-chain registry
  units.rs              invariant 5: balance -> underlying units
  nav.rs                invariant 1: NAV from oracle, never from a DEX
  oracle.rs             Pyth reads, staleness and confidence
  economics.rs          every token minted or paid out
  depeg.rs              deviation test and the guard table
  instructions/         one file per group
config/                 the registry, the devnet fixture, the feeds
scripts/                devnet operation and the mainnet preflight
tests/                  litesvm integration, frontend parity, browser safety
frontend/               Next.js on Vercel
```

`Quorum_Spec_v5.pdf` is the original spec; read it with `pdftotext -layout`.
Where the build departs from it, the README says why.

## Non-negotiable invariants

Correctness requirements, not preferences. Violating one is a money bug.

1. **NAV never reads a DEX price.** `NAV = sum(balance_i * units_per_token_i * (1 - haircut_i)) * oracle_price`. DEX prices exist *only* to detect depegs.
2. **Trust measured balance deltas, never quoted amounts.** Read the vault token account before and after every transfer and use the difference.
3. **Both legs of every swap are checked against the on-chain registry**, never against caller input. A vault can only hold its own registered wrappers. Quarantined wrappers drop out of the allowed set automatically.
4. **Every permissionless instruction is bounded.** `swap_depegged` and `rebalance` are a loan and a settle: `begin_*` lends the source tokens and proves by instruction introspection that `end_swap` runs later in the same transaction; the caller fills anywhere; `end_swap` requires the destination to clear its floor on gross units, the basket total to hold, and the destination to stay inside `max_weight_bps`. The vault signs no route anywhere in the program. If a hostile caller could make the vault worse off, the instruction is wrong.
5. **Token-2022 balances are read as the Scaled UI Amount, never raw.** Reading raw silently undervalues NAV after every dividend and over-mints against it. The most likely silent accounting bug in the design; `tests_scaled_ui.rs` exists to catch a regression.
6. **The guardian can only restrict**: pause and quarantine. Never withdraw or redirect. `escalate` refuses to move a wrapper *down* the severity scale, and unpausing needs the authority.
7. **No user action waits on a keeper.** Mint and redeem each settle in one transaction. No request accounts, nothing to settle later.

## Working rules

- **Do not invent issuer behaviour.** If a dividend or redemption mechanism is
  undocumented (Backpack's and Oro's are), ask rather than assuming. A wrong
  assumption here silently misprices NAV.
- **Mainnet means real money.** Run `npm run deploy-preflight`, which prints
  exactly what is about to happen and what it costs, and wait for a go-ahead
  before the first mainnet transaction. Keep position and per-transaction caps
  on from the first deploy.
- **Say what is untested.** If a path has only run against a stubbed venue,
  that belongs in the README.
- **Credentials stay out of the repo.** The Pyth key and the private RPC URLs
  live in `frontend/.env.local`, which is gitignored, and nowhere else.
- Small commits, each one runnable.

## Parameters

Read them off the vault account (`npm run devnet:status`, or the table at
`/docs`), not from the compiled defaults: `update_vault_config` can move any of
them. The defaults are mint and redeem fee 0.10% each, market-closed surcharge
+0.30%, rebalance drift trigger 5pp, depeg soft 2% held 10 min and hard 5%,
`max_swap_bps` 10% per call with a 5 min cooldown, caller reward 10% of
realised gain, NAV circuit breaker 8% within 10 min. A `units_per_token` change
over 1% needs the guardian to co-sign.

## Running it

```bash
cargo build-sbf                  # build the program
anchor build                     # build + IDL, and reports stack-frame overflows
cargo test -p quorum --lib       # 51 unit tests
npm test                         # 56 integration and parity tests
npm run devnet:status            # read-only: baskets, weights, oracle age
cd frontend && npm run dev
```

Every devnet script prints a plan and spends nothing until `--send`.
