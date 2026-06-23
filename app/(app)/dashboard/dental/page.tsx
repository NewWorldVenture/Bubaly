import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Dental Records' };

export default async function DentalPage() {
  await requireFeature('/dashboard/dental');
  return <MedicalRecordsModule kind="dental" />;
}
