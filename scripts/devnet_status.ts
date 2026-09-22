/**
 * Print the live state of the devnet deployment. Reads only.
 *
 *   npm run devnet:status
 *
 * Per vault: status, the oracle it reads and how stale that reading is, the
 * index supply, and each leg's balance against its target weight. Useful on
 * its own, and the thing to look at first when a script fails, because most
 * failures are a guard doing its job rather than a bug: a leg over
 * `max_weight_bps`, or a price past `max_age_seconds`.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { MOCK_VAULTS, type DevnetState } from '../config/devnet_wrappers.js';
import { feedFor } from '../config/devnet_feeds.js';
import { MULTIPLIER, SEEDS } from './lib/codec.js';
import { RPC_URL, connection, loadDevnetState } from './lib/env.js';

const STATUS = ['ACTIVE', 'MARKET_CLOSED', 'PAUSED', 'HALTED'];

async function balanceOf(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? info.data.readBigUInt64LE(64) : 0n;
}

async function main() {
  const conn = connection();
  const state = loadDevnetState<DevnetState>();
  console.log(`\nQuorum on devnet\n  rpc     ${RPC_URL}\n  program ${state.programId}\n`);

  for (const v of MOCK_VAULTS) {
    const vault = SEEDS.vault(v.symbol);
    const info = await conn.getAccountInfo(vault);
    if (!info) {
      console.log(`${v.symbol}  not deployed\n`);
      continue;
    }
    // Vault layout: disc(8) bump(1) symbol(12) unit(1) status(1).
    const status = STATUS[info.data[22]] ?? `unknown(${info.data[22]})`;

    const feed = feedFor(v.symbol);
    const priceAccount = state.priceUpdates[v.symbol];
    let priceLine = 'no price account recorded';
    if (priceAccount) {
      const pi = await conn.getAccountInfo(new PublicKey(priceAccount));
      if (!pi) {
        priceLine = 'price account missing on-chain';
      } else {
        // PriceUpdateV2: disc(8) write_authority(32) verification(1)
        //                feed_id(32) price(i64) conf(u64) exponent(i32)
        //                publish_time(i64)
        const o = 8 + 32 + 1 + 32;
        const price = pi.data.readBigInt64LE(o);
        const exponent = pi.data.readInt32LE(o + 16);
        const publishTime = Number(pi.data.readBigInt64LE(o + 20));
        const age = Math.floor(Date.now() / 1000) - publishTime;
        const usd = Number(price) * 10 ** exponent;
        priceLine = `${feed.label} ${usd.toFixed(2)} USD, ${age}s old${
          age > 3600 ? '  STALE, re-run devnet:prices' : ''
        }`;
      }
    }

    const supplyInfo = await conn.getAccountInfo(SEEDS.indexMint(vault));
    const supply = supplyInfo ? Number(supplyInfo.data.readBigUInt64LE(36)) / 1e9 : 0;

    console.log(`${v.symbol}  ${status}`);
    console.log(`  oracle  ${priceLine}${feed.standIn ? '  (stand-in)' : ''}`);
    console.log(`  supply  ${supply.toFixed(6)} ${v.symbol}`);

    const held: { key: string; tokens: number; target: number; scaled: boolean }[] = [];
    for (const w of v.wrappers) {
      const mint = new PublicKey(state.mints[w.key]);
      const raw = await balanceOf(conn, SEEDS.vaultToken(vault, mint));
      held.push({
        key: w.key,
        tokens: Number(raw) / 10 ** w.decimals,
        target: w.targetWeightBps / 100,
        scaled: w.multiplierSource === MULTIPLIER.Token2022ScaledUi,
      });
    }
    // Every mock is one unit per token, so token counts compare directly.
    // The program does not assume this; it converts through units_per_token.
    const total = held.reduce((a, h) => a + h.tokens, 0);
    for (const h of held) {
      const weight = total > 0 ? (100 * h.tokens) / total : 0;
      const drift = weight - h.target;
      console.log(
        `  ${h.key.padEnd(9)} ${h.tokens.toFixed(6).padStart(14)}  ` +
          `${weight.toFixed(2).padStart(6)}%  target ${h.target.toFixed(2)}%  ` +
          `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}pp` +
          `${h.scaled ? '  scaled-ui' : ''}`,
      );
    }
    console.log(`  cap     ${(v.maxWeightBps / 100).toFixed(0)}% per issuer\n`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
