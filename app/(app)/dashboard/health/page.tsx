import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { HealthModule } from '@/components/modules/health-module';

export const metadata: Metadata = { title: 'Health' };

export default async function HealthPage() {
  await requirePlanLevel(1);
  return <HealthModule />;
}
