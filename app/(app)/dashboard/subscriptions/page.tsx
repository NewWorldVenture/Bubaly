import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { SubscriptionsModule } from '@/components/modules/subscriptions-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Subscriptions' };

export default async function SubscriptionsPage() {
  const ctx = await requireFeature('/dashboard/subscriptions');
  await requireAal2(ctx, 'money', '/dashboard/subscriptions');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('subscriptions.subscriptions')}</h1>
      <SubscriptionsModule />
    </>
  );
}
