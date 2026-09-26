import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SecurityModule } from '@/components/modules/security-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.securityAlerts') };
}

export default async function SecurityPage() {
  await requireFeature('/dashboard/security');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('security.securityAlerts')}</h1>
      <SecurityModule />
    </>
  );
}
