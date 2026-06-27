import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { RenewalsModule } from '@/components/modules/renewals-module';

export const metadata: Metadata = { title: 'Renewals & Expirations | Bubaly' };

export default async function RenewalsPage() {
  await requireFeature('/dashboard/renewals');
  return <RenewalsModule />;
}
