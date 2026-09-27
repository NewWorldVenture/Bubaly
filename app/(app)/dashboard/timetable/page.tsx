import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { TimetableModule } from '@/components/modules/timetable-module';

export const metadata: Metadata = { title: 'Timetable' };

export default async function TimetablePage() {
  await requireFeature('/dashboard/timetable');
  return <TimetableModule />;
}
