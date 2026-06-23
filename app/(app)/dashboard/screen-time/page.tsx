import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ScreenTimeModule } from '@/components/modules/screen-time-module';

export const metadata: Metadata = { title: 'Screen Time' };

export default async function ScreenTimePage() {
  await requireFeature('/dashboard/screen-time');
  return <ScreenTimeModule />;
}
