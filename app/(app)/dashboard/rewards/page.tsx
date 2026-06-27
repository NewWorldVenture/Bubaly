import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { RewardsModule } from '@/components/modules/rewards-module';

export const metadata: Metadata = { title: 'Rewards & Allowance | Bubaly' };

export default async function RewardsPage() {
  await requireFeature('/dashboard/rewards');
  return <RewardsModule />;
}
