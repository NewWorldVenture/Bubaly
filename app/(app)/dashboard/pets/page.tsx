import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { PetsModule } from '@/components/modules/pets-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.pets') };
}

export default async function PetsPage() {
  await requireFeature('/dashboard/pets');
  return <PetsModule />;
}
