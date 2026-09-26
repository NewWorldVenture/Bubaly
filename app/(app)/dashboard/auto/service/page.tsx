import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getServiceRecords, getVehicles } from '@/lib/auto/queries';
import { AutoServiceClient } from '@/components/auto/service-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('conciergeCalls.categoryService')} · ${t('displayComfort.auto')}` };
}
export const dynamic = 'force-dynamic';

export default async function AutoServicePage() {
  const ctx = await requirePlanLevel(1);
  const [records, vehicles] = await Promise.all([getServiceRecords(ctx.active.familyId), getVehicles(ctx.active.familyId)]);
  return <AutoServiceClient records={records} vehicles={vehicles} />;
}
