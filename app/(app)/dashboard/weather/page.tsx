import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { WeatherModule } from '@/components/modules/weather-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.weather') };
}

export default async function WeatherPage() {
  await requireUserContext();
  return <WeatherModule />;
}
