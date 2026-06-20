import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { GoalsModule } from '@/components/modules/goals-module';

export const metadata: Metadata = { title: 'Goals' };

export default async function GoalsPage() {
  await requirePlanLevel(1);
  return <GoalsModule />;
}
