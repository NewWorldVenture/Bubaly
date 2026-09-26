import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { AnnouncementsModule } from '@/components/modules/announcements-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.announcements') };
}

export default async function AnnouncementsPage() {
  await requireFeature('/dashboard/announcements');
  return <AnnouncementsModule />;
}
