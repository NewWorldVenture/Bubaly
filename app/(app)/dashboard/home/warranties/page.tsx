import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getWarranties, getAssets } from '@/lib/home/queries';
import { WarrantiesClient } from '@/components/home/warranties-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('warrantiesClient.warranties')} · ${t('navLabel.home')}` };
}
export const dynamic = 'force-dynamic';

export default async function WarrantiesPage() {
  const ctx = await requirePlanLevel(1);
  const [warranties, assets] = await Promise.all([
    getWarranties(ctx.active.familyId),
    getAssets(ctx.active.familyId),
  ]);
  return <WarrantiesClient warranties={warranties} assets={assets} />;
}
