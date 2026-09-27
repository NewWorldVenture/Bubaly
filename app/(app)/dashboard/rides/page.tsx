import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { RidesModule } from '@/components/modules/rides-module';

export const metadata: Metadata = { title: 'Rides & Carpool' };

export default async function RidesPage() {
  await requireFeature('/dashboard/rides');
  return <RidesModule />;
}
