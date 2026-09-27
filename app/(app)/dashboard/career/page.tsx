import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { CareerModule } from '@/components/modules/career-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.careerHub') };
}

export default async function CareerPage() {
  await requireFeature('/dashboard/career');
  return <CareerModule />;
}
