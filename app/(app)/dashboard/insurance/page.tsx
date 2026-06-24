import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { InsuranceModule } from '@/components/modules/insurance-module';

export const metadata: Metadata = { title: 'Insurance Hub' };

export default async function InsurancePage() {
  await requireUserContext();
  return <InsuranceModule />;
}
