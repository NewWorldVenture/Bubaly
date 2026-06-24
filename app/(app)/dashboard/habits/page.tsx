import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { HabitsModule } from '@/components/modules/habits-module';

export const metadata: Metadata = { title: 'Habits' };

export default async function HabitsPage() {
  await requireFeature('/dashboard/habits');
  return <HabitsModule />;
}
