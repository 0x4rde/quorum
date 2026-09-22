/**
 * Fetch each wrapper's official logo and vendor it into the frontend.
 *
 *   npm run fetch-logos
 *
 * The source is Jupiter's token API, keyed by the wrapper's real mainnet
 * mint, so what lands here is the logo the issuer themselves publish for that
 * token rather than a generic one scraped from a logo site. `GOLD` comes from
 * Oro's own repository, `SPYx` from Backed's metadata host, `SPYon` from
 * Ondo's CDN, and so on.
 *
 * They are copied into `frontend/public/logos/` rather than hotlinked. A
 * hotlink makes every visitor's browser fetch from five different issuer
 * domains, which is slower, leaks the visit to each of them, and breaks the
 * page the day one of those hosts moves a file. Vendoring costs a few
 * kilobytes in the repository and nothing at runtime.
 *
 * Re-run it if the lineup changes. It skips a logo that is already present.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { VAULTS } from '../frontend/src/lib/vaults.js';

const OUT_DIR = 'frontend/public/logos';
/** Generated map of wrapper key to served path, imported by the UI. */
const MANIFEST = 'frontend/src/lib/logos.json';
const JUPITER = 'https://lite-api.jup.ag/tokens/v2/search';

/** Anything bigger than this is not an icon and should not be committed. */
const MAX_BYTES = 400_000;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Candidate URLs for one icon, best first.
 *
 * An issuer that publishes to IPFS gives a gateway URL, and the public
 * ipfs.io gateway rate-limits hard enough to fail on a run of nine. The
 * content hash is the real identifier, so the same object can be pulled from
 * any gateway; these are tried in turn.
 */
function candidates(url: string): string[] {
  const m = url.match(/\/ipfs\/([A-Za-z0-9]+)/);
  if (!m) return [url];
  const cid = m[1];
  return [
    url,
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://dweb.link/ipfs/${cid}`,
    `https://cloudflare-ipfs.com/ipfs/${cid}`,
  ];
}

async function iconUrlFor(mint: string): Promise<string | null> {
  const r = await fetch(`${JUPITER}?query=${mint}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const body = (await r.json()) as { icon?: string }[];
  return body?.[0]?.icon ?? null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const wrappers = VAULTS.flatMap((v) => v.wrappers.map((w) => ({ ...w, vault: v.symbol })));

  const manifest: Record<string, string> = {};

  for (const w of wrappers) {
    const existing = ['png', 'jpg', 'webp', 'svg']
      .map((e) => `${OUT_DIR}/${w.key}.${e}`)
      .find((p) => existsSync(p));
    if (existing) {
      manifest[w.key] = `/logos/${existing.split('/').pop()}`;
      console.log(`  ${w.key.padEnd(8)} already present`);
      continue;
    }

    const url = await iconUrlFor(w.mint);
    if (!url) {
      console.log(`  ${w.key.padEnd(8)} no icon published`);
      continue;
    }

    let saved = false;
    let lastError = 'no candidates';
    for (const candidate of candidates(url)) {
      try {
        const res = await fetch(candidate, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        const ext = EXT[type];
        if (!ext) throw new Error(`not an image: ${type || 'no content-type'}`);

        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_BYTES) throw new Error(`${bytes.length} bytes, too large for an icon`);

        const file = `${OUT_DIR}/${w.key}.${ext}`;
        writeFileSync(file, bytes);
        manifest[w.key] = `/logos/${w.key}.${ext}`;
        console.log(`  ${w.key.padEnd(8)} ${String(bytes.length).padStart(7)} bytes  ${type}`);
        saved = true;
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    if (!saved) console.log(`  ${w.key.padEnd(8)} skipped: ${lastError}`);
  }

  // Rebuild the manifest from the directory rather than from this run, so a
  // run that fetched nothing new still writes the complete map.
  const onDisk: Record<string, string> = {};
  for (const file of readdirSync(OUT_DIR).sort()) {
    const key = file.replace(/\.[^.]+$/, '');
    onDisk[key] = `/logos/${file}`;
  }
  writeFileSync(MANIFEST, `${JSON.stringify(onDisk, null, 2)}\n`);

  console.log(`\n${Object.keys(onDisk).length} of ${wrappers.length} wrappers have a logo.`);
  console.log(`Wrote ${MANIFEST}. Missing ones fall back to a monogram in the UI.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
