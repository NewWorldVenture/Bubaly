import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { HabitsModule } from '@/components/modules/habits-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.habits') };
}

export default async function HabitsPage() {
  await requireFeature('/dashboard/habits');
  return <HabitsModule />;
}
