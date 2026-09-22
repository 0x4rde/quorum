/**
 * Shared setup for the operational scripts: which cluster, which keypair,
 * which Hermes endpoint.
 *
 * Cluster comes from `CLUSTER` (`devnet` or `mainnet`), defaulting to devnet,
 * because devnet is the safe mistake and mainnet is not. Every script that
 * spends says which cluster it is on before it does anything.
 *
 * The Pyth credentials live in `frontend/.env.local`, which is gitignored.
 * Nothing here ever prints the key.
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';

/** Parse a dotenv-style file without pulling the values into `process.env`. */
function readDotenv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export type Cluster = 'devnet' | 'mainnet';

export const CLUSTER: Cluster = process.env.CLUSTER === 'mainnet' ? 'mainnet' : 'devnet';

/**
 * The RPC every script talks to.
 *
 * `frontend/.env.local` is consulted because that file is already the one
 * gitignored place credentials live, and a private endpoint URL is a
 * credential: anyone holding it can spend the quota. The public endpoint
 * stays as the fallback, so a fresh checkout still works, just slowly.
 */
export const RPC_URL = (() => {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (CLUSTER === 'mainnet') return 'https://api.mainnet-beta.solana.com';
  const fromEnvFile = readDotenv('frontend/.env.local').SOLANA_DEVNET_RPC_URL;
  return fromEnvFile ?? 'https://api.devnet.solana.com';
})();

/** The Anchor program id. Same on both clusters; a program id is per-chain. */
export const PROGRAM_ID = '3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi';

/**
 * Pyth price-feed shard for the accounts this project posts.
 *
 * A shard is just a namespace in the `[shard, feed_id]` PDA seed, and the
 * first writer of a shard becomes its write authority. Pyth maintains 0 and 1
 * on mainnet; picking a different one on devnet avoids colliding with
 * anything Pyth or another project might post.
 */
export const QUORUM_SHARD = Number(process.env.PYTH_SHARD ?? 42);

/** Where the devnet deployment records its mock mints and vault addresses. */
export const DEVNET_STATE = 'config/devnet.json';

/**
 * Read `config/devnet.json`, with a message that names the missing step
 * rather than the missing file. The setup scripts run in a fixed order and
 * each one depends on the last.
 */
export function loadDevnetState<T>(): T {
  try {
    return JSON.parse(readFileSync(DEVNET_STATE, 'utf8')) as T;
  } catch {
    throw new Error(
      `No ${DEVNET_STATE} yet. The devnet setup runs in this order:\n` +
        '  1. solana program deploy       (see npm run deploy-preflight)\n' +
        '  2. npm run devnet:mocks   -- --send\n' +
        '  3. npm run devnet:prices  -- --send\n' +
        '  4. npm run devnet:init    -- --send\n' +
        '  5. npm run devnet:demo    -- --send',
    );
  }
}

/**
 * The RPC connection.
 *
 * The websocket endpoint is named separately because a private HTTP provider
 * does not necessarily serve subscriptions on the matching wss:// address,
 * and web3.js confirms transactions by subscribing. Alchemy's devnet
 * endpoint answers `signatureSubscribe` with "method not found", which
 * surfaces as every send timing out at "block height exceeded" while the
 * transaction has in fact landed. Sending over the fast private endpoint and
 * confirming over the public socket keeps both parts doing what they are
 * good at.
 */
export function connection(): Connection {
  const wsEndpoint =
    process.env.RPC_WS_URL ??
    (CLUSTER === 'mainnet' ? 'wss://api.mainnet-beta.solana.com/' : 'wss://api.devnet.solana.com/');
  return new Connection(RPC_URL, { commitment: 'confirmed', wsEndpoint });
}

export function keypairAt(path: string): Keypair {
  const expanded = path.replace(/^~/, process.env.HOME ?? '~');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expanded, 'utf8'))));
}

/** The CLI's configured signer, which is what `solana program deploy` uses. */
export function payer(): Keypair {
  return keypairAt(process.env.KEYPAIR ?? '~/.config/solana/id_owner.json');
}

export interface Hermes {
  url: string;
  key: string;
}

/**
 * Hermes now rejects unauthenticated requests for every feed, so the key is
 * required rather than optional. Missing it is a stop, not a warning.
 */
export function hermes(): Hermes {
  const env = readDotenv('frontend/.env.local');
  const key = process.env.PYTH_API_KEY ?? env.PYTH_API_KEY;
  if (!key) {
    throw new Error(
      'No PYTH_API_KEY. Put it in frontend/.env.local (gitignored), not in a tracked file.',
    );
  }
  const url = (process.env.PYTH_HERMES_URL ?? env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network')
    .replace(/\/$/, '');
  return { url, key };
}

/** Fetch the latest signed price update for each feed id, base64 encoded. */
export async function fetchPriceUpdates(feedIds: string[]): Promise<string[]> {
  const { url, key } = hermes();
  const query = feedIds.map((f) => `ids[]=${f.replace(/^0x/, '')}`).join('&');
  const res = await fetch(`${url}/v2/updates/price/latest?${query}&encoding=base64`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(
      `Hermes ${res.status} for ${feedIds.join(', ')}. ` +
        'A 403 means the key is not entitled to that feed. Entitlements are per-feed: ' +
          'a key that prices BTC can still be refused SPY.',
    );
  }
  const body = (await res.json()) as { binary: { data: string[] } };
  return body.binary.data;
}

/** True when the script was invoked with `--send`, which is what spends SOL. */
export const WILL_SPEND = process.argv.includes('--send');

export function banner(what: string) {
  console.log(`\n${what}`);
  console.log(`  cluster  ${CLUSTER}`);
  console.log(`  rpc      ${RPC_URL}`);
  console.log(`  mode     ${WILL_SPEND ? 'SEND (spends SOL)' : 'dry run (simulate only)'}\n`);
}
