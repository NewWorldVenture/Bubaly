import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { DonationsModule } from '@/components/modules/donations-module';

export const metadata: Metadata = { title: 'Donation Tracker' };

export default async function DonationsPage() {
  await requireUserContext();
  return <DonationsModule />;
}
