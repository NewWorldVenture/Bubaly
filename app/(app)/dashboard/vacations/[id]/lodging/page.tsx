import { requireFeature } from '@/lib/supabase/auth';
import { TripLodging } from '@/components/vacations/trip-lodging';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripLodging vacationId={id} />;
}
