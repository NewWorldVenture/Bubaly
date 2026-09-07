import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MedicalRecordsModule } from '@/components/modules/medical-records-module';
import { HealthVisitsModule } from '@/components/modules/health-visits-module';
import { ImmunizationsModule } from '@/components/modules/immunizations-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Medical Records' };

export default async function MedicalPage() {
  const t = await getTranslations();
  await requireFeature('/dashboard/medical');
  return (
    <div className="space-y-8">
      <MedicalRecordsModule kind="medical" />
      <HealthVisitsModule title={t('dashboardMedical.visitHistory')} />
      <ImmunizationsModule title={t('dashboardMedical.immunizationsVaccines')} />
    </div>
  );
}
