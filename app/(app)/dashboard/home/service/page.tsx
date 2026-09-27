import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getServiceRecords, getAssets } from '@/lib/home/queries';
import { ServiceClient } from '@/components/home/service-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.serviceLog')} · ${t('navLabel.home')}` };
}
export const dynamic = 'force-dynamic';

export default async function ServicePage() {
  const ctx = await requirePlanLevel(1);
  const [records, assets] = await Promise.all([
    getServiceRecords(ctx.active.familyId),
    getAssets(ctx.active.familyId),
  ]);
  return <ServiceClient records={records} assets={assets} />;
}
