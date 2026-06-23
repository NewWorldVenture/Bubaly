import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { GoalsModule } from '@/components/modules/goals-module';

export const metadata: Metadata = { title: 'Goals' };

export default async function GoalsPage() {
  await requireFeature('/dashboard/goals');
  return <GoalsModule />;
}
