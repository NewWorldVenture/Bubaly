import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BillingModule } from '@/components/modules/billing-module';

export const metadata: Metadata = { title: 'Billing' };

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingModule />
    </Suspense>
  );
}
