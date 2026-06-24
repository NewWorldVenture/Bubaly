import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsReports } from '@/components/vacations/vacations-reports';

export const metadata: Metadata = { title: 'Vacation Reports | Bubaly' };

export default async function VacationsReportsPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsReports />;
}
