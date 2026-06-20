import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Medical Records' };

export default async function MedicalPage() {
  await requirePlanLevel(1);
  return <MedicalRecordsModule kind="medical" />;
}
