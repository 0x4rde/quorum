'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/vault/qSPY', label: 'Vaults' },
  { href: '/docs', label: 'Docs' },
  { href: '/transparency', label: 'Transparency' },
  { href: '/keeper', label: 'Keeper' },
];

/**
 * The mark is the product: a miniature basket bar — two neutral segments and
 * one accent, unequal weights. It is the same object the vault page is built
 * around, so the brand and the signature component are one thing.
 */
function Mark() {
  return (
    <span className="flex h-[15px] w-[22px] gap-[2px]" aria-hidden>
      <span className="h-full flex-[38] rounded-[1.5px] bg-[#39414A]" />
      <span className="h-full flex-[34] rounded-[1.5px] bg-[#2C333A]" />
      <span className="h-full flex-[28] rounded-[1.5px] bg-accent" />
    </span>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <nav className="sticky top-0 z-20 h-14 border-b border-hairline bg-page/95 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1180px] items-center justify-between px-4 md:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Quorum</span>
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active = path.startsWith(l.href.split('/').slice(0, 2).join('/'));
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`mono rounded-[5px] px-3 py-2 text-[11px] uppercase tracking-[0.1em] transition-colors ${
                  active ? 'text-ink' : 'text-faint hover:text-dim'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
