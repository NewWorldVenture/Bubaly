import { requireFeature } from '@/lib/supabase/auth';
import { TripDocuments } from '@/components/vacations/trip-documents';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireFeature('/dashboard/vacations');
  return <TripDocuments vacationId={id} />;
}
