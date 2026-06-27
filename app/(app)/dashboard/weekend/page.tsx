import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { WeekendModule } from '@/components/modules/weekend-module';

export const metadata: Metadata = { title: 'Weekend Planner | Bubaly' };

export default async function WeekendPage() {
  await requireFeature('/dashboard/weekend');
  return <WeekendModule />;
}
