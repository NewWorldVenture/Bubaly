import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { UtilitiesModule } from '@/components/modules/utilities-module';

export const metadata: Metadata = { title: 'Utility Tracking' };

export default async function UtilitiesPage() {
  await requireFeature('/dashboard/utilities');
  return <UtilitiesModule />;
}
