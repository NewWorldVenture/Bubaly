import { requireFeature } from '@/lib/supabase/auth';
import { TripBudget } from '@/components/vacations/trip-budget';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripBudget vacationId={id} />;
}
