import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SleepModule } from '@/components/modules/sleep-module';

export const metadata: Metadata = { title: 'Sleep Coach' };

export default async function SleepPage() {
  await requireFeature('/dashboard/sleep');
  return <SleepModule />;
}
