import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { FindPhoneView } from '@/components/family/find-phone-view';

export const metadata: Metadata = { title: 'Find Phone' };

export default async function FindPhonePage() {
  await requireUserContext();
  return <FindPhoneView />;
}
