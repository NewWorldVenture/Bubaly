import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { FocusModule } from '@/components/modules/focus-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.focusMode') };
}

export default async function FocusPage() {
  await requireFeature('/dashboard/focus');
  return <FocusModule />;
}
