import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Quorum: issuer-diversified RWA vaults',
  description:
    'Every major tokenized wrapper of one asset, in one token, priced by oracle NAV instead of any single pool.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Nav />
        {children}
        <Footer />
      </body>
    </html>
  );
}

/**
 * The last thing a sceptical reader scrolls past, so it answers the
 * sceptic's questions: what is this, where is the code, how audited is it,
 * where is it running. One line, no columns of link-farm.
 */
function Footer() {
  return (
    <footer className="mt-20 border-t border-hairline">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-8 md:px-8">
        <span className="text-[12.5px] text-faint">
          Quorum — issuer-diversified RWA vaults
        </span>
        <a
          href="https://github.com/0x4rde/quorum"
          target="_blank"
          rel="noreferrer noopener"
          className="mono text-[11px] uppercase tracking-[0.12em] text-dim transition-colors hover:text-accent"
        >
          GitHub ↗
        </a>
        <Link
          href="/docs"
          className="mono text-[11px] uppercase tracking-[0.12em] text-dim transition-colors hover:text-accent"
        >
          Docs
        </Link>
        <Link
          href="/transparency"
          className="mono text-[11px] uppercase tracking-[0.12em] text-dim transition-colors hover:text-accent"
        >
          Transparency
        </Link>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="mono rounded-[5px] border border-[rgba(251,191,36,.28)] bg-[rgba(251,191,36,.08)] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] text-warn">
            Unaudited
          </span>
          <span className="mono rounded-[5px] border border-[rgba(251,191,36,.28)] bg-[rgba(251,191,36,.08)] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] text-warn">
            Live on devnet
          </span>
        </span>
      </div>
    </footer>
  );
}
