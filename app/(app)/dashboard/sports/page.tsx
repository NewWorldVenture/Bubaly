import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { SportsModule } from '@/components/modules/sports-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.sportsHub') };
}

export default async function SportsPage() {
  await requireFeature('/dashboard/sports');
  return <SportsModule />;
}
