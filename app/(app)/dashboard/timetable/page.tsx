import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { TimetableModule } from '@/components/modules/timetable-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.timetable') };
}

export default async function TimetablePage() {
  await requireFeature('/dashboard/timetable');
  return <TimetableModule />;
}
