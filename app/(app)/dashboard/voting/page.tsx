import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VotingModule } from '@/components/modules/voting-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.groupVoting') };
}

export default async function VotingPage() {
  await requireFeature('/dashboard/voting');
  return <VotingModule />;
}
