# Quorum frontend

Next.js 16 on Vercel and Tailwind. Reads the devnet deployment live; mint and
redeem run from a browser wallet.

## Deploying to Vercel

Root directory: `frontend`. Framework preset: Next.js. No build overrides
needed.

Environment variables:

| Name | Required | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | recommended | Defaults to the public mainnet endpoint, which will rate-limit under any real traffic. |
| `PYTH_HERMES_URL` | optional | Defaults to `https://pyth.dourolabs.app/hermes`, where Pyth moved the hosted Hermes in the 2026-08-26 Core upgrade. Point it at a self-hosted instance to avoid the key entirely — Hermes is open source. |
| `PYTH_API_KEY` | **yes, to mint** | Hermes price routes have required a key since 2026-08-26. Sign up at https://pythdata.app/signup (free trial, paid after). **The key also needs an equity-feed grant**, accepted in the same terminal — a key that prices BTC will still 403 on SPY. |

Nothing here reaches a third party from the browser. `/api/prices`,
`/api/quote` and `/api/holdings` run server-side so the RPC endpoint stays out
of client bundles (spec §11b).

## Local

    npm install
    npm run dev

## Data sources

- **Prices** — the on-chain `PriceUpdateV2` accounts, *not* Hermes. The program
  reads those accounts, so the UI reads the same ones and reports staleness as
  the program would see it. Showing a live Hermes price beside a stale on-chain
  account would display a number the vault cannot act on.
- **Quotes** — Jupiter, with `maxAccounts` forced server-side. Left uncapped,
  Jupiter returns routes that cannot fit in a transaction alongside the mint
  instruction (Q10), and the failure is an intermittent "transaction too large"
  that is miserable to diagnose from the UI.
- **Supply and multipliers** — `getMultipleAccounts` against the wrapper mints.
  The Scaled UI multiplier shown on the transparency page is parsed out of the
  Token-2022 TLV.
