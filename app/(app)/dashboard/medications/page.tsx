import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { MedicationsModule } from '@/components/modules/medications-module';

export const metadata: Metadata = { title: 'Medications | Bubaly' };

export default async function MedicationsPage() {
  await requirePlanLevel(1);
  return <MedicationsModule />;
}
