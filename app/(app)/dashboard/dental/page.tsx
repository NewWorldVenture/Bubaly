import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Dental Records' };

export default async function DentalPage() {
  await requirePlanLevel(1);
  return <MedicalRecordsModule kind="dental" />;
}
