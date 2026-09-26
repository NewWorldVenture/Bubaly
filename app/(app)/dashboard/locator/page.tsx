import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { LocatorModule } from '@/components/modules/locator-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.familyMap') };
}

export default async function LocatorPage() {
  await requireFeature('/dashboard/locator');
  return <LocatorModule />;
}
