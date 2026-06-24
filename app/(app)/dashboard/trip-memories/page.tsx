import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { TripMemoriesModule } from '@/components/modules/trip-memories-module';

export const metadata: Metadata = { title: 'Trip Memories' };

export default async function TripMemoriesPage() {
  await requireFeature('/dashboard/trip-memories');
  return <TripMemoriesModule />;
}
