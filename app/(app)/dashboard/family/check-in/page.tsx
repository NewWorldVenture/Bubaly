import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { CheckInView } from '@/components/family/check-in-view';

export const metadata: Metadata = { title: 'Check In' };

export default async function CheckInPage() {
  await requireUserContext();
  return <CheckInView />;
}
