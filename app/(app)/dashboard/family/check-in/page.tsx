import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { CheckInView } from '@/components/family/check-in-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.checkIn') };
}

export default async function CheckInPage() {
  refuseGuest(await requireUserContext(), '/dashboard/family/check-in');
  return <CheckInView />;
}
