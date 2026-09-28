import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SecurityModule } from '@/components/modules/security-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.securityAlerts') };
}

export default async function SecurityPage() {
  await requireFeature('/dashboard/security');
  return <SecurityModule />;
}
