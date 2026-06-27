import { requireFeature } from '@/lib/supabase/auth';
import { TripConcierge } from '@/components/vacations/trip-concierge';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripConcierge vacationId={id} />;
}
