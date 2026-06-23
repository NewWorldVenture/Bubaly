import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';

export const metadata: Metadata = { title: 'Medical Records' };

export default async function MedicalPage() {
  await requireFeature('/dashboard/medical');
  return <MedicalRecordsModule kind="medical" />;
}
