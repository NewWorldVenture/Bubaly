import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsList } from '@/components/vacations/vacations-list';

export const metadata: Metadata = { title: 'Vacation Planner | Bubaly' };

export default async function VacationsPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsList />;
}
