import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BillingModule } from '@/components/modules/billing-module';
import { FinancesModule } from '@/components/modules/finances-module';
import { CloseAccountCard } from '@/components/app/close-account-card';
import { createServiceClient } from '@/lib/supabase/server';
import { serviceFeeEnabled, resolveServiceFeeCents, formatServiceFee } from '@/lib/stripe/service-fee';
import { getTranslations } from '@/lib/i18n/server';

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
  // Both notices are translated (C1-S9-71): BillingModule renders this string
  // as-is, so an English literal here reached every locale unchanged.
  const t = await getTranslations();
  let serviceFeeNotice: string | null = null;
  try {
    const { data, error } = await createServiceClient()
      .from('stripe_settings').select('enabled, service_fee_cents, service_fee_price_id').eq('id', 'singleton').maybeSingle();
    if (error) {
      // This notice exists so a family is told about a fee BEFORE they pay. A
      // refused read used to land here with `data` null and show nothing — the
      // `catch` below cannot see a resolved error — so a configured fee went
      // undisclosed. We cannot know whether a fee applies, so say only what is
      // true either way: Stripe Checkout itemises every charge before payment.
      // Silence is the one answer that could mislead. Audit C1-S9-71.
      console.error('[billing] service fee settings read failed; showing the cautious notice', error);
      serviceFeeNotice = t('billing.serviceFeeShownAtCheckout');
    } else if (serviceFeeEnabled(data)) {
      serviceFeeNotice = t('billing.serviceFeeAddedAtCheckout', { fee: formatServiceFee(resolveServiceFeeCents(data)) });
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
