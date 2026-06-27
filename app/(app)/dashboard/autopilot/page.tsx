import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { AutopilotModule } from '@/components/modules/autopilot-module';

export const metadata: Metadata = { title: 'Family Autopilot' };

export default async function AutopilotPage() {
  await requireFeature('/dashboard/autopilot');
  return <AutopilotModule />;
}
