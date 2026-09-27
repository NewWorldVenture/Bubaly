import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { RenewalsModule } from '@/components/modules/renewals-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('renewals.renewalsExpirations') };
}

export default async function RenewalsPage() {
  await requireFeature('/dashboard/renewals');
  return <RenewalsModule />;
}
