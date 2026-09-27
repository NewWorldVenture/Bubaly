import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { MovingModule } from '@/components/modules/moving-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.movePlanner') };
}

export default async function MovingPage() {
  await requireFeature('/dashboard/moving');
  return <MovingModule />;
}
