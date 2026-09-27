import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { WeekendModule } from '@/components/modules/weekend-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.weekendPlanner') };
}

export default async function WeekendPage() {
  await requireFeature('/dashboard/weekend');
  return <WeekendModule />;
}
