# Support request to Pyth

Send to `support@pyth.network`, copying `data@dourolabs.xyz`.

The ready-to-send copy, with the API key filled in, is at
`docs/pyth_support_request.filled.md`, which is gitignored. Regenerate it with
`npm run pyth-letter`. The key stays out of this file because this one is
committed, and a credential in git history does not go away when you delete
the line.

---

**Subject:** Temporary devnet feed access for a hackathon project

Hello,

Account: 4rdiii111@gmail.com
API key: [see the filled copy]

I am building Quorum, a tokenized real-world-asset vault program on Solana,
for the STOCKLANA hackathon (deadline 25 September 2026). It is deployed and
working on devnet and reads Pyth for NAV and for detecting when a tokenized
wrapper depegs from its underlying.

**Could we get temporary, devnet-only access to a handful of feeds so we can
finish testing?** Nothing about this is production: it is a hackathon entry
running on devnet with mock tokens and no users, and we are not in a position
to take on a commercial plan for it. Low rate limits are completely fine; we
poll a few times a minute at most. A time-boxed grant that expires after the
hackathon would suit us perfectly.

The feeds we read:

| Feed | Id |
|---|---|
| `Metal.XAU/USD` | `765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2` |
| `Equity.US.SPY/USD` | `19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5` |
| `Equity.US.MSTR/USD` | `e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09` |
| `Crypto.PAXG/USD` | `273717b49430906f4b0c230e99aa1007f83758e3199edbc887c0d06c3e332494` |
| `Crypto.XAUT/USD` | `44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67` |
| `Crypto.SPYX/USD` | `2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14` |
| `Crypto.MSTRX/USD` | `53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28` |

If only some of those are possible, the three underlyings (XAU, SPY, MSTR)
are the ones that unblock the most: without them a vault cannot price its
basket at all. The four wrapper feeds only drive depeg detection.

Also: do redemption-rate (`.RR`) feeds exist for the xStocks tokens SPYx and
MSTRx? We use one to cross-check their Token-2022 Scaled UI multiplier.

**Separately, is TWAP available at all?** Our depeg test compares a wrapper's
TWAP against the underlying's. Two things suggest it may be retired rather
than gated:

- `GET /v2/updates/twap/300/latest?ids[]=<feed>` returns **404**, not 401 or
  403, so the route looks absent rather than permissioned.
- On Solana mainnet there are only two `TwapUpdate` accounts owned by the
  receiver program (`CExo2c3S…` SOL/USD and `HSu9fDD7…` ETH/USD), both last
  updated about 553 days ago.

If TWAP is no longer supported we will build a pool-based TWAP instead, so a
straight answer either way saves us guessing.

Happy to share the repository or a demo link if that helps.

Thanks,

[name]
4rdiii111@gmail.com
