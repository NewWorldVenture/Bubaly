import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ChoresModule } from '@/components/modules/chores-module';

export const metadata: Metadata = { title: 'Chores' };

export default async function ChoresPage() {
  await requireFeature('/dashboard/chores');
  return <ChoresModule />;
}
