import { requireFeature } from '@/lib/supabase/auth';
import { TripFamily } from '@/components/vacations/trip-family';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripFamily vacationId={id} />;
}
