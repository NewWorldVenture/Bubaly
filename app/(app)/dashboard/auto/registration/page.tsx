import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getRegistrations, getInspections, getVehicles } from '@/lib/auto/queries';
import { RegistrationClient } from '@/components/auto/registration-client';
import { readsHouseholdMoney } from '@/lib/finance/household-money';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.registrationInspection')} · ${t('displayComfort.auto')}` };
}
export const dynamic = 'force-dynamic';

export default async function RegistrationPage() {
  const ctx = await requirePlanLevel(1);
  const [registrations, inspections, vehicles] = await Promise.all([
    getRegistrations(ctx.active.familyId, { role: ctx.active.role, userId: ctx.user.id }), getInspections(ctx.active.familyId), getVehicles(ctx.active.familyId),
  ]);
  return <RegistrationClient registrations={registrations} inspections={inspections} vehicles={vehicles} ownOnly={!readsHouseholdMoney(ctx.active.role)} />;
}
