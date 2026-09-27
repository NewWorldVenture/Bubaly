import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsReports } from '@/components/vacations/vacations-reports';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('vacationsReports.vacationReports') };
}

export default async function VacationsReportsPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsReports />;
}
