import { notFound } from 'next/navigation';
import { VAULTS, bySymbol } from '@/lib/vaults';
import { VaultView } from './VaultView';

export function generateStaticParams() {
  return VAULTS.map((v) => ({ symbol: v.symbol }));
}

export default async function Page({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const vault = bySymbol(symbol);
  if (!vault) notFound();
  return <VaultView vault={vault} />;
}
