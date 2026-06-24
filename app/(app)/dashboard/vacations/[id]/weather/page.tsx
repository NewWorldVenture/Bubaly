import { requireFeature } from '@/lib/supabase/auth';
import { TripWeather } from '@/components/vacations/trip-weather';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripWeather vacationId={id} />;
}
