import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicationsModule } from '@/components/modules/medications-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.medications') };
}

export default async function MedicationsPage() {
  await requireFeature('/dashboard/medications');
  return <MedicationsModule />;
}
