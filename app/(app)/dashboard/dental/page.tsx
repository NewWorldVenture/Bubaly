import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';
import { HealthVisitsModule } from '@/components/modules/health-visits-module';

export const metadata: Metadata = { title: 'Dental Records' };

export default async function DentalPage() {
  await requireFeature('/dashboard/dental');
  return (
    <div className="space-y-8">
      <MedicalRecordsModule kind="dental" />
      <HealthVisitsModule defaultKind="dental" lockKind title="Dental visits & cleanings" />
    </div>
  );
}
