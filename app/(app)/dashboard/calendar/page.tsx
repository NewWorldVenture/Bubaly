import type { Metadata } from 'next';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { CalendarModule } from '@/components/modules/calendar-module';

export const metadata: Metadata = { title: 'Calendar' };

export default function CalendarPage() {
  return <><RelatedOutcomes href="/dashboard/calendar" /><CalendarModule /></>;
}
