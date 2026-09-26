import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { SignupsModule } from '@/components/modules/signups-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('signups.registrationsSignups') };
}

export default async function SignupsPage() {
  await requireFeature('/dashboard/signups');
  return <SignupsModule />;
}
