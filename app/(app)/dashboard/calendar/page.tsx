import type { Metadata } from 'next';
import { CalendarModule } from '@/components/modules/calendar-module';

export const metadata: Metadata = { title: 'Calendar' };

export default function CalendarPage() {
  return <CalendarModule />;
}
