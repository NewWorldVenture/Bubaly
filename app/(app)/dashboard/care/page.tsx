import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { CareModule } from '@/components/modules/care-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.careLog') };
}

export default async function CarePage() {
  await requireFeature('/dashboard/care');
  return <CareModule />;
}
