import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { BehaviorModule } from '@/components/modules/behavior-module';

export const metadata: Metadata = { title: 'Behavior' };

export default async function BehaviorPage() {
  await requireFeature('/dashboard/behavior');
  return <BehaviorModule />;
}
