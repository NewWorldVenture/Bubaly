import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { HomeworkModule } from '@/components/modules/homework-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.homework') };
}

export default async function HomeworkPage() {
  await requireFeature('/dashboard/homework');
  return <HomeworkModule />;
}
