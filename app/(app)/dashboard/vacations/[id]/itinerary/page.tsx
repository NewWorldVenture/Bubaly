import { requireFeature } from '@/lib/supabase/auth';
import { TripItinerary } from '@/components/vacations/trip-itinerary';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripItinerary vacationId={id} />;
}
