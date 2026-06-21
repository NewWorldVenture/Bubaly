import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { WeatherModule } from '@/components/modules/weather-module';

export const metadata: Metadata = { title: 'Weather' };

export default async function WeatherPage() {
  await requireUserContext();
  return <WeatherModule />;
}
