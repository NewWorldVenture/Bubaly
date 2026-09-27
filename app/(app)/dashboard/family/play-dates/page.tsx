import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { PlayDatesView } from '@/components/family/play-dates-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.playDates') };
}

export default async function PlayDatesPage() {
  await requireUserContext();
  return <PlayDatesView />;
}
