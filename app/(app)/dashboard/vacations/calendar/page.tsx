import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { VacationsCalendar } from '@/components/vacations/vacations-calendar';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('vacationsCalendar.vacationCalendar') };
}

export default async function VacationsCalendarPage() {
  await requireFeature('/dashboard/vacations');
  return <VacationsCalendar />;
}
