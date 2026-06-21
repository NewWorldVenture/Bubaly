import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getVehicles, getPolicies } from '@/lib/auto/queries';
import { AccidentClient } from '@/components/auto/accident-client';

export const metadata: Metadata = { title: 'Accident Help · Auto' };
export const dynamic = 'force-dynamic';

export default async function AccidentPage() {
  const ctx = await requirePlanLevel(1);
  const [vehicles, policies] = await Promise.all([getVehicles(ctx.active.familyId), getPolicies(ctx.active.familyId)]);
  const claimsPhone = policies.find((p) => p.is_active && p.claims_phone)?.claims_phone ?? null;
  return <AccidentClient vehicles={vehicles} claimsPhone={claimsPhone} />;
}
