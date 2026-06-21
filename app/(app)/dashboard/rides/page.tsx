import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { RidesModule } from '@/components/modules/rides-module';

export const metadata: Metadata = { title: 'Rides & Carpool | Bubaly' };

export default async function RidesPage() {
  await requirePlanLevel(1);
  return <RidesModule />;
}
