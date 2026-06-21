import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { TripsModule } from '@/components/modules/trips-module';

export const metadata: Metadata = { title: 'Trip Planner | Bubaly' };

export default async function TripsPage() {
  await requirePlanLevel(1);
  return <TripsModule />;
}
