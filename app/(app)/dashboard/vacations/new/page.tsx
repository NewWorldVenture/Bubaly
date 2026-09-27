import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsList } from '@/components/vacations/vacations-list';

export const metadata: Metadata = { title: 'New Trip' };

export default async function NewVacationPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsList openCreate />;
}
