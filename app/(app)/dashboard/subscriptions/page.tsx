import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { SubscriptionsModule } from '@/components/modules/subscriptions-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.subscriptions') };
}

export default async function SubscriptionsPage() {
  const ctx = await requireFeature('/dashboard/subscriptions');
  await requireAal2(ctx, 'money', '/dashboard/subscriptions');
  return <SubscriptionsModule />;
}
