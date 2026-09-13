import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { InsuranceModule } from '@/components/modules/insurance-module';

export const metadata: Metadata = { title: 'Insurance Hub' };

export default async function InsurancePage() {
  await requireFeature('/dashboard/insurance');
  return <InsuranceModule />;
}
