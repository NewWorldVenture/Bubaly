import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BillingModule } from '@/components/modules/billing-module';
import { FinancesModule } from '@/components/modules/finances-module';
import { CloseAccountCard } from '@/components/app/close-account-card';
import { createServiceClient } from '@/lib/supabase/server';
import { serviceFeeEnabled, resolveServiceFeeCents, formatServiceFee } from '@/lib/stripe/service-fee';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { returnPathWith } from '@/lib/auth/mfa';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.finances') };
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // This is the money area's front door, so it takes the money area's guard.
  //
  // The nine pages BELOW it in the sidebar (savings, budgets, expenses, bills,
  // autopay, payments, subscriptions, money-timeline, family-cfo) each call
  // `requireAal2(ctx, 'money', …)`; this one carried no guard at all — not even
  // `requireUserContext`. Both of its views read every account, transaction,
  // budget and savings goal, and ?view=manage puts a trash icon beside each, so
  // a manager who enrolled an authenticator and signed in with the password
  // alone was bounced off all nine children and let straight into the parent.
  // Some of those writes go to PostgREST from the browser (`deleteBill`,
  // `markBillPaid`, `deleteAccount`), which no server-side check can intercept
  // — not rendering the page is the only thing that stops them.
  //
  // It returns the session to the query the page was reached with, not the bare
  // path: the plan gate sends families here as ?upgrade=1&need=… and the
  // "Manage" links as ?view=manage, and entering a code must not lose either.
  const ctx = await requireUserContext();
  const params = await searchParams;
  await requireAal2(ctx, 'money', returnPathWith('/dashboard/billing', params));

  // Default = the family Finances dashboard. The full manager (Transactions /
  // Budgets / Bills / Savings / Reports + plan & subscription) lives at
  // ?view=manage, reachable from the dashboard's "More"/"View all" links.
  const { view } = params;
  if (view !== 'manage') {
    return (
      <Suspense fallback={null}>
        <FinancesModule />
      </Suspense>
    );
  }

  // Honest disclosure: if the Bubaly service fee is configured + enabled, tell
  // families before they pay. Reads only the non-secret fee config.
  //
  // In the reader's language and money format: the sentence is a catalogue key
  // and the amount is formatted for the locale this request resolved, so a
  // German parent reads "0,90 $" inside de-DE's own sentence rather than "$0.90"
  // inside English. tests/a-german-family-reads-their-plan-price-in-their-own-format.test.ts
  // fails if de-DE lacks its own translation of billing.serviceFeeAddedAtCheckout.
  // Resolved OUTSIDE the try below, whose catch is for a missing table only.
  const tr = await getTranslations();
  const { locale } = await getLocaleContext();
  let serviceFeeNotice: string | null = null;
  try {
    const { data } = await createServiceClient()
      .from('stripe_settings').select('enabled, service_fee_cents, service_fee_price_id').eq('id', 'singleton').maybeSingle();
    if (serviceFeeEnabled(data)) {
      serviceFeeNotice = tr('billing.serviceFeeAddedAtCheckout', { amount: formatServiceFee(resolveServiceFeeCents(data), locale.code) });
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
