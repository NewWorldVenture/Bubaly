import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';
import { HealthVisitsModule } from '@/components/modules/health-visits-module';

export const metadata: Metadata = { title: 'Medical Records' };

export default async function MedicalPage() {
  await requireFeature('/dashboard/medical');
  return (
    <div className="space-y-8">
      <MedicalRecordsModule kind="medical" />
      <HealthVisitsModule title="Visit history" />
    </div>
  );
}
