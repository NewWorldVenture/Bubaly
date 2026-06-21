import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { RenewalsModule } from '@/components/modules/renewals-module';

export const metadata: Metadata = { title: 'Renewals & Expirations | Bubaly' };

export default async function RenewalsPage() {
  await requirePlanLevel(1);
  return <RenewalsModule />;
}
