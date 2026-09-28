// lib/admin/subscription-revenue.ts — the one definition of monthly revenue the
// admin console reports, shared by /admin/billing and /admin/reports.
//
// Revenue is what PAYING subscriptions bring in: `status = 'active'`. A trial
// has not paid, and Stripe's own MRR leaves trials out. /admin/billing counted
// `trialing` as active and as revenue while /admin/reports did not, so the two
// pages showed different "Active Subscriptions" and different monthly revenue
// for the same families (METRIC-002). Trials are counted, separately.
import { planMonthlyCents } from '@/lib/constants/plans';

type Subscription = { plan: string | null; status: string | null };

export function subscriptionRevenue<T extends Subscription>(rows: readonly T[]) {
  const paying = rows.filter((s) => s.status === 'active');
  const trialing = rows.filter((s) => s.status === 'trialing');
  const pastDue = rows.filter((s) => s.status === 'past_due' || s.status === 'unpaid');
  const mrrCents = paying.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  return { paying, trialing, pastDue, mrrCents };
}
