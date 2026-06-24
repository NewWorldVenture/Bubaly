import { requireFeature } from '@/lib/supabase/auth';
import { TripTravel } from '@/components/vacations/trip-travel';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripTravel vacationId={id} />;
}
