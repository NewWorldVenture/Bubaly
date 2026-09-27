import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { SleepModule } from '@/components/modules/sleep-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.sleepCoach') };
}

export default async function SleepPage() {
  await requireFeature('/dashboard/sleep');
  return <SleepModule />;
}
