import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsCalendar } from '@/components/vacations/vacations-calendar';

export const metadata: Metadata = { title: 'Vacation Calendar | Bubaly' };

export default async function VacationsCalendarPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsCalendar />;
}
