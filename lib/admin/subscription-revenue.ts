// lib/admin/subscription-revenue.ts — the one definition of monthly revenue the
// admin console reports, shared by /admin/billing and /admin/reports.
//
// Revenue is what PAYING subscriptions bring in: `status = 'active'`. A trial
// has not paid, and Stripe's own MRR leaves trials out. /admin/billing counted
// `trialing` as active and as revenue while /admin/reports did not, so the two
// pages showed different "Active Subscriptions" and different monthly revenue
// for the same families (METRIC-002). Trials are counted, separately.
//
// A row may also be a TALLY: a head:true count of the subscriptions that share
// one plan and one status, carried as `count`. /admin/billing reads its figures
// that way, so they hold past any row ceiling (review
// R6-BILLING-CEILING-STILL-WHOLE-PAGE); /admin/reports passes the rows it read,
// each of which stands for one subscription. Either way the statuses are sorted
// here, and nowhere else.
import { planMonthlyCents } from '@/lib/constants/plans';

type Subscription = { plan: string | null; status: string | null; count?: number };

/** How many subscriptions these stand for: a row is one, a tally is its count. */
export function subscriptionsIn(rows: readonly Subscription[]): number {
  return rows.reduce((n, s) => n + (s.count ?? 1), 0);
}

export function subscriptionRevenue<T extends Subscription>(rows: readonly T[]) {
  const paying = rows.filter((s) => s.status === 'active');
  const trialing = rows.filter((s) => s.status === 'trialing');
  const pastDue = rows.filter((s) => s.status === 'past_due' || s.status === 'unpaid');
  const mrrCents = paying.reduce((sum, s) => sum + planMonthlyCents(s.plan) * (s.count ?? 1), 0);
  return { paying, trialing, pastDue, mrrCents };
}
