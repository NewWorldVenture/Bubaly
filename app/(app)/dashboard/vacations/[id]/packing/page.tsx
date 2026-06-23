import { requireFeature } from '@/lib/supabase/auth';
import { TripPacking } from '@/components/vacations/trip-packing';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripPacking vacationId={id} />;
}
