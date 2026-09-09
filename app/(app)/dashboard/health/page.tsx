import type { Metadata } from 'next';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { HealthModule } from '@/components/modules/health-module';

export const metadata: Metadata = { title: 'Health' };

export default async function HealthPage() {
  await requireFeature('/dashboard/health');
  return <><RelatedOutcomes href="/dashboard/health" /><HealthModule /></>;
}
