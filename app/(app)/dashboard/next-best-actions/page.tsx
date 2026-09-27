import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { NextActionsModule } from '@/components/modules/next-actions-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.nextBestActions') };
}

export default async function NextBestActionsPage() {
  await requireUserContext();
  return <NextActionsModule />;
}
