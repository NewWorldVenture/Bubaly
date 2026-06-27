import { requireFeature } from '@/lib/supabase/auth';
import { TripActivities } from '@/components/vacations/trip-activities';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripActivities vacationId={id} />;
}
