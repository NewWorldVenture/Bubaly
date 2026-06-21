import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getRegistrations, getInspections, getVehicles } from '@/lib/auto/queries';
import { RegistrationClient } from '@/components/auto/registration-client';

export const metadata: Metadata = { title: 'Registration & Inspection · Auto' };
export const dynamic = 'force-dynamic';

export default async function RegistrationPage() {
  const ctx = await requirePlanLevel(1);
  const [registrations, inspections, vehicles] = await Promise.all([
    getRegistrations(ctx.active.familyId), getInspections(ctx.active.familyId), getVehicles(ctx.active.familyId),
  ]);
  return <RegistrationClient registrations={registrations} inspections={inspections} vehicles={vehicles} />;
}
