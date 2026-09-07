import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { settle } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { getVehicles } from '@/lib/auto/queries';
import { VehiclesClient } from '@/components/auto/vehicles-client';

export const metadata: Metadata = { title: 'Vehicles · Auto' };
export const dynamic = 'force-dynamic';

export default async function VehiclesPage() {
  const ctx = await requirePlanLevel(1);
  const supabase = await createServer();
  const [vehicles, { data: members }] = await Promise.all([
    getVehicles(ctx.active.familyId),
    settle(supabase.from('family_members').select('id, display_name').eq('family_id', ctx.active.familyId).eq('is_active', true)),
  ]);
  return <VehiclesClient vehicles={vehicles} members={members ?? []} />;
}
