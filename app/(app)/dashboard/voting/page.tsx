import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { VotingModule } from '@/components/modules/voting-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Group Voting' };

export default async function VotingPage() {
  await requireFeature('/dashboard/voting');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('voting.groupVoting')}</h1>
      <VotingModule />
    </>
  );
}
