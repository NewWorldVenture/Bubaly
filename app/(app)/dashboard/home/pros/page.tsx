import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getContractors } from '@/lib/home/queries';
import { ProsClient } from '@/components/home/pros-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('prosClient.findAPro')} · ${t('navLabel.home')}` };
}
export const dynamic = 'force-dynamic';

export default async function ProsPage({ searchParams }: { searchParams: Promise<{ trade?: string }> }) {
  const ctx = await requirePlanLevel(1);
  const { trade } = await searchParams;
  const contractors = await getContractors(ctx.active.familyId);
  return <ProsClient contractors={contractors} initialTrade={trade ?? ''} />;
}
