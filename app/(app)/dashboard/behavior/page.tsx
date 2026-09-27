import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { BehaviorModule } from '@/components/modules/behavior-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.behavior') };
}

export default async function BehaviorPage() {
  await requireFeature('/dashboard/behavior');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('behavior.pageTitle')}</h1>
      <BehaviorModule />
    </>
  );
}
