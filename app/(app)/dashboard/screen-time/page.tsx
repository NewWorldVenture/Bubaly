import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ScreenTimeModule } from '@/components/modules/screen-time-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.screenTime') };
}

export default async function ScreenTimePage() {
  await requireFeature('/dashboard/screen-time');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('screenTime.pageTitle')}</h1>
      <ScreenTimeModule />
    </>
  );
}
