/**
 * Copy the devnet deployment record into the frontend.
 *
 *   npm run devnet:sync
 *
 * The frontend deploys to Vercel from its own directory and cannot read the
 * repo root at build time, which is why `frontend/src/lib/vaults.ts` is a
 * copy rather than an import. Same constraint here, same answer, except this
 * copy is generated rather than hand-maintained: it merges the addresses in
 * `config/devnet.json` with the per-wrapper metadata in
 * `config/devnet_wrappers.ts` and the feed bindings in
 * `config/devnet_feeds.ts`, so the page has everything it needs in one file
 * and nobody has to remember to update three.
 *
 * Re-run it after any devnet script that writes `config/devnet.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { DEVNET_FEEDS } from '../config/devnet_feeds.js';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { MULTIPLIER, SEEDS } from './lib/codec.js';
import { DEVNET_STATE } from './lib/env.js';

const OUT = 'frontend/src/lib/devnet.json';

const SOURCE_NAMES: Record<number, string> = {
  [MULTIPLIER.Fixed]: 'FIXED',
  [MULTIPLIER.Token2022ScaledUi]: 'TOKEN2022_SCALED_UI',
  [MULTIPLIER.KeeperPushed]: 'KEEPER_PUSHED',
};

function main() {
  const state = JSON.parse(readFileSync(DEVNET_STATE, 'utf8')) as DevnetState;

  const vaults = MOCK_VAULTS.filter((v) => v.listed !== false).map((v) => {
    const feed = DEVNET_FEEDS.find((f) => f.vault === v.symbol);
    const addrs = state.vaults[v.symbol];
    if (!feed || !addrs) throw new Error(`${v.symbol} is not in ${DEVNET_STATE} yet`);
    return {
      symbol: v.symbol,
      vault: addrs.vault,
      indexMint: addrs.indexMint,
      maxWeightBps: v.maxWeightBps,
      priceAccount: state.priceUpdates[v.symbol] ?? null,
      feedId: feed.feedId,
      feedLabel: feed.label,
      /** Null on mainnet's real feed; a sentence when devnet substitutes one. */
      standIn: feed.standIn ?? null,
      wrappers: v.wrappers.map((w) => {
        const mint = new PublicKey(state.mints[w.key]);
        const vaultKey = new PublicKey(addrs.vault);
        return {
          key: w.key,
          standsFor: w.standsFor,
          mainnetKey: w.mainnetKey,
          mint: mint.toBase58(),
          decimals: w.decimals,
          multiplierSource: SOURCE_NAMES[w.multiplierSource],
          initialMultiplier: w.initialMultiplier ?? null,
          targetWeightBps: w.targetWeightBps,
          // The feed the on-chain depeg check reads for this holding, and
          // the account its price was posted to. Null where the issuer
          // publishes none, which is why some rows can never show a premium.
          wrapperFeedId: w.wrapperFeedId ?? null,
          wrapperPriceAccount: w.wrapperFeedId
            ? (state.wrapperPrices?.[w.wrapperFeedId] ?? null)
            : null,
          rrFeedId: w.rrFeedId ?? null,
          rrPriceAccount: w.rrFeedId ? (state.wrapperPrices?.[w.rrFeedId] ?? null) : null,
          // Derived here so the frontend ships no PDA logic of its own, and
          // so every address the page renders is one this script produced.
          tokenAccount: SEEDS.vaultToken(vaultKey, mint).toBase58(),
          wrapperConfig: SEEDS.wrapper(vaultKey, mint).toBase58(),
        };
      }),
    };
  });

  const out = {
    _generated: `by scripts/sync_frontend_devnet.ts from ${DEVNET_STATE}. Do not edit.`,
    cluster: state.cluster,
    programId: state.programId,
    authority: state.authority,
    deployedAt: state.createdAt,
    vaults,
    /** The mock dollar every pool is priced against. */
    usdcMint: state.mints.mUSDC ?? null,
    /** Liquidity pools, so the UI can route a purchase without re-deriving them. */
    pools: state.pools ?? {},
  };

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${OUT}: ${vaults.length} vaults, ${Object.keys(state.mints).length} mints.`);
}

main();
