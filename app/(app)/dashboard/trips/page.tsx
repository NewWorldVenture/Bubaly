import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { TripsModule } from '@/components/modules/trips-module';

export const metadata: Metadata = { title: 'Trip Planner | Bubaly' };

export default async function TripsPage() {
  await requireFeature('/dashboard/trips');
  return <TripsModule />;
}
