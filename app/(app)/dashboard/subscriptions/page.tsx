import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { SubscriptionsModule } from '@/components/modules/subscriptions-module';

export const metadata: Metadata = { title: 'Subscriptions' };

export default async function SubscriptionsPage() {
  const ctx = await requireFeature('/dashboard/subscriptions');
  await requireAal2(ctx, 'money', '/dashboard/subscriptions');
  return <SubscriptionsModule />;
}
