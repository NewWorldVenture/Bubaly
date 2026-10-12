import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { DrivingSafetyView } from '@/components/family/driving-safety-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.drivingSafety') };
}

export default async function DrivingSafetyPage() {
  refuseGuest(await requireUserContext(), '/dashboard/family/driving-safety');
  return <DrivingSafetyView />;
}
