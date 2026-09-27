import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsList } from '@/components/vacations/vacations-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.newTrip') };
}

export default async function NewVacationPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsList openCreate />;
}
