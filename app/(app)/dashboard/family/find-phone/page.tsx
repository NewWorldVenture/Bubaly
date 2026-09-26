import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { FindPhoneView } from '@/components/family/find-phone-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.findPhone') };
}

export default async function FindPhonePage() {
  await requireUserContext();
  return <FindPhoneView />;
}
