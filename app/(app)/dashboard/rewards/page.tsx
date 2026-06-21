import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { RewardsModule } from '@/components/modules/rewards-module';

export const metadata: Metadata = { title: 'Rewards & Allowance | Bubaly' };

export default async function RewardsPage() {
  await requirePlanLevel(1);
  return <RewardsModule />;
}
