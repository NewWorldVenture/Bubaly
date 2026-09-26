import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { DevicesModule } from '@/components/modules/devices-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.smartHome') };
}

export default async function DevicesPage() {
  await requireFeature('/dashboard/devices');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('devices.smartHome')}</h1>
      <DevicesModule />
    </>
  );
}
