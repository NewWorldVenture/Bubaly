import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { RidesModule } from '@/components/modules/rides-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.ridesCarpool') };
}

export default async function RidesPage() {
  await requireFeature('/dashboard/rides');
  return <RidesModule />;
}
