import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { BinderModule } from '@/components/modules/binder-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Household Binder' };

export default async function BinderPage() {
  const ctx = await requireFeature('/dashboard/binder');
  await requireAal2(ctx, 'documents', '/dashboard/binder');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('binder.householdBinder')}</h1>
      <BinderModule />
    </>
  );
}
