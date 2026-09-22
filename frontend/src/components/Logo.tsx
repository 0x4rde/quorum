'use client';

import { useState } from 'react';
import manifest from '@/lib/logos.json';

/**
 * A wrapper's own logo.
 *
 * The images in `public/logos` are the ones each issuer publishes for their
 * token, vendored by `scripts/fetch_logos.ts` from the mint's metadata rather
 * than collected from a logo site, so what appears beside PAXG is Paxos's
 * mark for PAXG and not a generic gold coin.
 *
 * Backpack publishes no icon for SPYbp, and a wrapper can be added before its
 * logo is fetched, so the fallback is a monogram rather than a broken image.
 * The same fallback covers a file that 404s at runtime.
 */
export function Logo({
  wrapperKey,
  size = 20,
  className = '',
}: {
  /** The `key` from the registry, e.g. `PAXG`. */
  wrapperKey: string;
  size?: number;
  className?: string;
}) {
  const src = (manifest as Record<string, string>)[wrapperKey];
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        className={`mono inline-flex shrink-0 items-center justify-center rounded-full border border-hairline bg-raised text-faint ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        title={wrapperKey}
        aria-hidden
      >
        {wrapperKey.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    // Plain <img>: these are small, already local, and next/image would add a
    // loader round trip for no benefit at this size.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full bg-[#0D1013] object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The vault's issuers, stacked, for the page header.
 *
 * A vault has no logo of its own, and picking one wrapper's mark to stand for
 * the whole basket would say the opposite of what the product is. Overlapping
 * every live issuer says it in one glyph: several marks, one token. The
 * quarantine and weight story is told below; this is just the lineup.
 */
export function LogoStack({
  wrapperKeys,
  size = 44,
  className = '',
}: {
  wrapperKeys: string[];
  size?: number;
  className?: string;
}) {
  if (wrapperKeys.length === 0) return null;
  // A third of a mark's width of overlap: enough to read as one object,
  // little enough that each logo is still identifiable.
  const overlap = Math.round(size / 3);

  return (
    <span className={`inline-flex shrink-0 items-center ${className}`} aria-hidden>
      {wrapperKeys.map((key, i) => (
        <span
          key={key}
          className="rounded-full ring-2 ring-[#0D1013]"
          style={{
            marginLeft: i === 0 ? 0 : -overlap,
            zIndex: wrapperKeys.length - i,
            lineHeight: 0,
          }}
        >
          <Logo wrapperKey={key} size={size} />
        </span>
      ))}
    </span>
  );
}
