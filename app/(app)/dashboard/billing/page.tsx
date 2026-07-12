import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BillingModule } from '@/components/modules/billing-module';
import { FinancesModule } from '@/components/modules/finances-module';
import { CloseAccountCard } from '@/components/app/close-account-card';
import { createServiceClient } from '@/lib/supabase/server';
import { serviceFeeEnabled, resolveServiceFeeCents, formatServiceFee } from '@/lib/stripe/service-fee';

export const metadata: Metadata = { title: 'Finances' };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  // Default = the family Finances dashboard. The full manager (Transactions /
  // Budgets / Bills / Savings / Reports + plan & subscription) lives at
  // ?view=manage, reachable from the dashboard's "More"/"View all" links.
  const { view } = await searchParams;
  if (view !== 'manage') {
    return (
      <Suspense fallback={null}>
        <FinancesModule />
      </Suspense>
    );
  }

  // Honest disclosure: if the Bubaly service fee is configured + enabled, tell
  // families before they pay. Reads only the non-secret fee config.
  let serviceFeeNotice: string | null = null;
  try {
    const { data } = await createServiceClient()
      .from('stripe_settings').select('enabled, service_fee_cents, service_fee_price_id').eq('id', 'singleton').maybeSingle();
    if (serviceFeeEnabled(data)) {
      serviceFeeNotice = `A one-time ${formatServiceFee(resolveServiceFeeCents(data))} Bubaly service fee is added at checkout.`;
    }
  } catch {
    /* stripe_settings may not exist yet — no notice */
  }

  return (
    <Suspense fallback={null}>
      <BillingModule serviceFeeNotice={serviceFeeNotice} />
      <CloseAccountCard />
    </Suspense>
  );
}
