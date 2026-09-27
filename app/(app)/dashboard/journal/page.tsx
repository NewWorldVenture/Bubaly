import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { JournalModule } from '@/components/modules/journal-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.journal') };
}

export default async function JournalPage() {
  await requireFeature('/dashboard/journal');
  return <JournalModule />;
}
