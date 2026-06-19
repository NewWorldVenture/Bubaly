import type { Metadata } from 'next';
import { BillingModule } from '@/components/modules/billing-module';

export const metadata: Metadata = { title: 'Billing' };

export default function BillingPage() {
  return <BillingModule />;
}
