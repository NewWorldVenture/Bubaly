import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { CheckInView } from '@/components/family/check-in-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.checkIn') };
}

// A guest reaches this page too: CheckInView reads only their own check-ins
// (the held 0509 keeps a guest's own rows, 0516 the member's) and lets them
// check in, which they always could. Everyone else's stay out of their view.
export default async function CheckInPage() {
  await requireUserContext();
  return <CheckInView />;
}
