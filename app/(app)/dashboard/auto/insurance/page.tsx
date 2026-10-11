import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { getPolicies, getVehicles } from '@/lib/auto/queries';
import { InsuranceClient } from '@/components/auto/insurance-client';
import { readsHouseholdMoney } from '@/lib/finance/household-money';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('printSheet.insurance')} · ${t('displayComfort.auto')}` };
}
export const dynamic = 'force-dynamic';

export default async function InsurancePage() {
  const ctx = await requirePlanLevel(1); refuseGuest(ctx, '/dashboard/auto/insurance');
  const [policies, vehicles] = await Promise.all([getPolicies(ctx.active.familyId, { role: ctx.active.role, userId: ctx.user.id }), getVehicles(ctx.active.familyId)]);
  return <InsuranceClient policies={policies} vehicles={vehicles} ownOnly={!readsHouseholdMoney(ctx.active.role)} />;
}
