import { isManager } from '@/lib/constants/roles';
import { requireFeature } from '@/lib/supabase/auth';
import { TripTravel } from '@/components/vacations/trip-travel';
import { DisruptionForm } from './disruption-form';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireFeature('/dashboard/vacations');
  // Reporting a disruption re-flows the shared itinerary and pages the whole
  // family; the server action refuses non-managers, so the form is not shown
  // to them either.
  return (
    <div className="space-y-8">
      <TripTravel vacationId={id} />
      {isManager(ctx.active.role) && <DisruptionForm vacationId={id} />}
    </div>
  );
}
