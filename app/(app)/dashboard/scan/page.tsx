import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { ScanModule } from '@/components/modules/scan-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.scanFlyer') };
}

export default async function ScanPage() {
  await requireFeature('/dashboard/scan');
  return <ScanModule />;
}
