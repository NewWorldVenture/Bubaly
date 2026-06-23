import { requireFeature } from '@/lib/supabase/auth';
import { TripEmergency } from '@/components/vacations/trip-emergency';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripEmergency vacationId={id} />;
}
