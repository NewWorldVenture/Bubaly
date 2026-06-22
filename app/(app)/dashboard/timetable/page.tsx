import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { TimetableModule } from '@/components/modules/timetable-module';

export const metadata: Metadata = { title: 'Timetable | Bubaly' };

export default async function TimetablePage() {
  await requirePlanLevel(1);
  return <TimetableModule />;
}
