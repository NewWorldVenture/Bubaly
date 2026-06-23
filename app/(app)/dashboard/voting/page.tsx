import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VotingModule } from '@/components/modules/voting-module';

export const metadata: Metadata = { title: 'Group Voting' };

export default async function VotingPage() {
  await requireFeature('/dashboard/voting');
  return <VotingModule />;
}
