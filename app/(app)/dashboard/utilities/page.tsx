import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { UtilitiesModule } from '@/components/modules/utilities-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('utilities.utilityTracking') };
}

export default async function UtilitiesPage() {
  await requireFeature('/dashboard/utilities');
  return <UtilitiesModule />;
}
