import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';
import { HealthVisitsModule } from '@/components/modules/health-visits-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Dental Records' };

export default async function DentalPage() {
  const t = await getTranslations();
  await requireFeature('/dashboard/dental');
  return (
    <div className="space-y-8">
      <MedicalRecordsModule kind="dental" />
      <HealthVisitsModule defaultKind="dental" lockKind title={t('dashboardDental.dentalVisitsCleanings')} />
    </div>
  );
}
