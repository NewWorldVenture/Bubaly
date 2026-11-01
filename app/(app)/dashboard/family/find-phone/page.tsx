import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { FindPhoneView } from '@/components/family/find-phone-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.findPhone') };
}

export default async function FindPhonePage() {
  refuseGuest(await requireUserContext(), '/dashboard/family/find-phone');
  return <FindPhoneView />;
}
