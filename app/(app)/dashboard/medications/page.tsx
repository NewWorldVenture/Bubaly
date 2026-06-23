import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicationsModule } from '@/components/modules/medications-module';

export const metadata: Metadata = { title: 'Medications | Bubaly' };

export default async function MedicationsPage() {
  await requireFeature('/dashboard/medications');
  return <MedicationsModule />;
}
