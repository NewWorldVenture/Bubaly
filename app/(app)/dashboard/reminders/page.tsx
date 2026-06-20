import type { Metadata } from 'next';
import { RemindersModule } from '@/components/modules/reminders-module';

export const metadata: Metadata = { title: 'Smart Reminders' };

export default function RemindersPage() {
  return <RemindersModule />;
}
