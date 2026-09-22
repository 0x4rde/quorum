'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/vault/qSPY', label: 'Vaults' },
  { href: '/docs', label: 'Docs' },
  { href: '/transparency', label: 'Transparency' },
  { href: '/keeper', label: 'Keeper' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="sticky top-0 z-20 h-14 border-b border-hairline bg-page/95 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1180px] items-center justify-between px-4 md:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="h-4 w-4 rounded-[3px]" style={{ background: 'linear-gradient(135deg,#A3E635,#39414A)' }} />
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
