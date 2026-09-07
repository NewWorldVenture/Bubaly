import { requireFeature } from '@/lib/supabase/auth';
import { TripTravel } from '@/components/vacations/trip-travel';
import { DisruptionForm } from './disruption-form';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return (
    <div className="space-y-8">
      <TripTravel vacationId={id} />
      <DisruptionForm vacationId={id} />
    </div>
  );
}
