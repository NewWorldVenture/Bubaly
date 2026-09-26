import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { InsuranceModule } from '@/components/modules/insurance-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.insuranceHub') };
}

export default async function InsurancePage() {
  await requireFeature('/dashboard/insurance');
  return <InsuranceModule />;
}
