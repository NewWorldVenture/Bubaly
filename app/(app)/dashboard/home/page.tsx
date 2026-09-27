import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { HomeModule } from '@/components/modules/home-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.homeMaintenance') };
}

export default async function HomePage() {
  await requirePlanLevel(1);
  return <HomeModule />;
}
