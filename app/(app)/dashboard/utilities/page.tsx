import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { UtilitiesModule } from '@/components/modules/utilities-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Utility Tracking' };

export default async function UtilitiesPage() {
  await requireFeature('/dashboard/utilities');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('utilities.pageTitle')}</h1>
      <UtilitiesModule />
    </>
  );
}
