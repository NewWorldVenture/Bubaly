import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { WeeklyBriefingModule } from '@/components/modules/weekly-briefing-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.weeklyBriefing') };
}

export default async function WeeklyBriefingPage() {
  await requireFeature('/dashboard/weekly-briefing');
  return <WeeklyBriefingModule />;
}
