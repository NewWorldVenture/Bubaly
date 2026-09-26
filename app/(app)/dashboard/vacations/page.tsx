import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsList } from '@/components/vacations/vacations-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.vacationPlanner') };
}

export default async function VacationsPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsList />;
}
