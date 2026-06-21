import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getPolicies, getVehicles } from '@/lib/auto/queries';
import { InsuranceClient } from '@/components/auto/insurance-client';

export const metadata: Metadata = { title: 'Insurance · Auto' };
export const dynamic = 'force-dynamic';

export default async function InsurancePage() {
  const ctx = await requirePlanLevel(1);
  const [policies, vehicles] = await Promise.all([getPolicies(ctx.active.familyId), getVehicles(ctx.active.familyId)]);
  return <InsuranceClient policies={policies} vehicles={vehicles} />;
}
