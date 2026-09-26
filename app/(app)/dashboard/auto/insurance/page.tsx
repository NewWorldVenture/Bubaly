import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getPolicies, getVehicles } from '@/lib/auto/queries';
import { InsuranceClient } from '@/components/auto/insurance-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('printSheet.insurance')} · ${t('displayComfort.auto')}` };
}
export const dynamic = 'force-dynamic';

export default async function InsurancePage() {
  const ctx = await requirePlanLevel(1);
  const [policies, vehicles] = await Promise.all([getPolicies(ctx.active.familyId), getVehicles(ctx.active.familyId)]);
  return <InsuranceClient policies={policies} vehicles={vehicles} />;
}
