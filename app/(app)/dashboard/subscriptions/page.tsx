import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SubscriptionsModule } from '@/components/modules/subscriptions-module';

export const metadata: Metadata = { title: 'Subscriptions' };

export default async function SubscriptionsPage() {
  await requireFeature('/dashboard/subscriptions');
  return <SubscriptionsModule />;
}
