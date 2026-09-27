import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { TripMemoriesModule } from '@/components/modules/trip-memories-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.tripMemories') };
}

export default async function TripMemoriesPage() {
  await requireFeature('/dashboard/trip-memories');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('tripMemories.tripMemories')}</h1>
      <TripMemoriesModule />
    </>
  );
}
