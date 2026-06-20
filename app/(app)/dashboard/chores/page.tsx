import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { ChoresModule } from '@/components/modules/chores-module';

export const metadata: Metadata = { title: 'Chores' };

export default async function ChoresPage() {
  await requirePlanLevel(1);
  return <ChoresModule />;
}
