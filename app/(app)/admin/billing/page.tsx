import type { Metadata } from 'next';
import Link from 'next/link';
import { DollarSign, CreditCard, Users, RefreshCw, AlertCircle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle, settleAll } from '@/lib/supabase/settle';
import { readAllAsQuery, readAllByIdAsQuery } from '@/lib/supabase/read-all';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Donut, Bars } from '@/components/admin/charts';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { PLAN_NAMES, planMonthlyCents, planName } from '@/lib/constants/plans';
import { subscriptionRevenue, subscriptionsIn } from '@/lib/admin/subscription-revenue';
import { getTranslations, getLocaleContext } from '@/lib/i18n/server';
import { ADMIN_ZONE, inWindow, lastUtcMonths } from '@/lib/admin/clock';

export const metadata: Metadata = { title: 'Admin · Billing', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success', trialing: 'neutral', past_due: 'warning', unpaid: 'danger',
  canceled: 'neutral', incomplete: 'warning', incomplete_expired: 'danger',
};

const PLAN_COLORS = ['#7c5dff', '#22c55e', '#60a5fa', '#fbbf24', '#f87171', '#64748b'];

/** Exactly the columns the recent table's select asks for, taken from the generated row. */
type SubscriptionRow = Pick<
  Tables<'subscriptions'>,
  'id' | 'family_id' | 'plan' | 'status' | 'created_at' | 'current_period_end'
>;
type TrendRow = Pick<Tables<'subscriptions'>, 'id' | 'plan' | 'created_at'>;

/** Rows the trend's paged read may go through before it is reported as a prefix (one round trip per 1,000). */
const ROW_CEILING = 50_000;
/** The recent table lists this many of the newest subscriptions. */
const RECENT_SHOWN = 10;
/** Every plan this page names and prices (lib/constants/plans.ts). */
const NAMED_PLANS = Object.keys(PLAN_NAMES);
/** The statuses the tiles count beside the paying one, which is counted per plan for the MRR. */
const COUNTED_STATUSES = ['trialing', 'past_due', 'unpaid'] as const;

export default async function AdminBillingPage() {
  const locale = (await getLocaleContext()).locale.code;
  const tr = await getTranslations();
  const supabase = createServiceClient();
  // Every figure on this page was reduced from ONE read of every subscription,
  // paged on the id to a 50,000-row ceiling with reaching it an error, so past
  // 50,000 subscriptions the whole page (the tiles, the donut, the trend and the
  // recent table) was the read-error state (review
  // R6-BILLING-CEILING-STILL-WHOLE-PAGE). Each part now reads only what it
  // shows, as /admin/subscriptions does:
  //   - Est. MRR, Active and the trials beside it, Past Due and the plan donut
  //     are `head: true` counts, exact and uncapped: one per status, and one
  //     per plan of the paying subscriptions, which priced is the MRR without
  //     reading a row. subscriptionRevenue sorts the counts into paying,
  //     trialing and past due, as it sorts /admin/reports' rows;
  //   - the trend reads only the subscriptions started inside its six months,
  //     paged on the id, so a checkout between two pages is not summed twice.
  //     Past the ceiling inside them the trend alone says it is not shown;
  //   - the recent table reads its RECENT_SHOWN newest rows, newest first.
  // Any read that FAILS is still the read-error state: on a revenue page,
  // refusing to show a number beats showing a smaller one with no way to tell.
  const trendStart = new Date(lastUtcMonths(6)[0].start).toISOString();
  const [
    [billingCustomersResult, subscriptionsResult, trendResult, otherPlansResult],
    planCountResults,
    statusCountResults,
  ] = await Promise.all([
    settleAll([
      supabase.from('billing_customers').select('id', { count: 'exact', head: true }),
      // The newest rows, listed rather than summed: a prefix is the answer.
      readAllAsQuery<SubscriptionRow>((from, to) => supabase.from('subscriptions')
        .select('id, family_id, plan, status, created_at, current_period_end')
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to), { max: RECENT_SHOWN, failOnMax: false }),
      readAllByIdAsQuery<TrendRow>((after, limit) => {
        let query = supabase.from('subscriptions').select('id, plan, created_at').gte('created_at', trendStart);
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING }),
      // Paying, on a plan this page has no name or price for.
      supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active').not('plan', 'in', `(${NAMED_PLANS.join(',')})`),
    ]),
    settleAll(NAMED_PLANS.map((plan) =>
      supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('plan', plan))),
    settleAll(COUNTED_STATUSES.map((status) =>
      supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', status))),
  ]);

  // The trend's rows past the ceiling cost the trend, not the tiles, the donut
  // and the recent rows beside it. Any other failure is the read-error state.
  const trendCeiling = 'truncated' in trendResult && trendResult.truncated;
  if (trendCeiling) console.warn('[admin-billing] the trend read reached its ceiling; the trend is not shown');
  const readError = subscriptionsResult.error ?? billingCustomersResult.error ?? otherPlansResult.error
    ?? (trendCeiling ? null : trendResult.error)
    ?? planCountResults.find((r) => r.error)?.error ?? statusCountResults.find((r) => r.error)?.error;
  if (readError) {
    console.error('[admin-billing] billing read failed', readError);
    return <AdminBillingReadError />;
  }

  const { count: billingCustomers } = billingCustomersResult;

  // A tally per counted plan and status. A null plan is a paying one this page
  // does not name, or a status whose plans it does not split. Paying
  // subscriptions only, as /admin/reports counts them: a trial is not revenue
  // (METRIC-002). Trials are shown on the Active tile, separately.
  const tally = [
    ...NAMED_PLANS.map((plan, i) => ({ plan, status: 'active', count: planCountResults[i]?.count ?? 0 })),
    { plan: null, status: 'active', count: otherPlansResult.count ?? 0 },
    ...COUNTED_STATUSES.map((status, i) => ({ plan: null, status, count: statusCountResults[i]?.count ?? 0 })),
  ];
  const { paying, trialing, pastDue, mrrCents } = subscriptionRevenue(tally);
  const payingCount = subscriptionsIn(paying);

  // Plan distribution (paying subs) — real.
  const planBuckets = new Map<string, number>();
  for (const s of paying) {
    if (s.count === 0) continue;
    const label = s.plan === null ? tr('adminBilling.otherPlans') : planName(s.plan);
    planBuckets.set(label, (planBuckets.get(label) ?? 0) + s.count);
  }
  const planSegments = [...planBuckets.entries()].map(([label, value], i) => ({ label, value, color: PLAN_COLORS[i % PLAN_COLORS.length] }));

  // New MRR added over the last 6 months — real, from subscription created_at.
  // Months in the admin zone, not the host's (lib/admin/clock.ts).
  const started = trendResult.data ?? [];
  const trend = lastUtcMonths(6).map((w) => {
    const value = started.filter((s) => inWindow(s.created_at, w))
      .reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
    return { label: new Date(w.start).toLocaleDateString(locale, { month: 'short', timeZone: ADMIN_ZONE }), value };
  });
  const maxTrend = Math.max(...trend.map((t) => t.value), 1);

  const recent = subscriptionsResult.data ?? [];

  // Only the families the recent table actually names. Reading every family to
  // build this map was both capped at a thousand — so a row past it rendered
  // "—" for a family that exists — and far more rows than ten names need.
  const recentFamilyIds = [...new Set(recent.map((s) => s.family_id).filter((id): id is string => !!id))];
  const familiesResult = recentFamilyIds.length
    ? await settle(supabase.from('families').select('id, name').in('id', recentFamilyIds))
    : { data: [] as { id: string; name: string }[], error: null };
  if (familiesResult.error) {
    console.error('[admin-billing] family name read failed', familiesResult.error);
  }
  const familyName = new Map((familiesResult.data ?? []).map((f) => [f.id, f.name]));

  const stats = [
    { label: 'Est. MRR', value: fmtMoney(mrrCents), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Active Subscriptions', value: payingCount.toLocaleString(), hint: `+ ${subscriptionsIn(trialing).toLocaleString()} trialing`, icon: CreditCard, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Billing Customers', value: (billingCustomers ?? 0).toLocaleString(), icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Past Due / Unpaid', value: subscriptionsIn(pastDue).toLocaleString(), icon: AlertCircle, tint: 'text-rose-400 bg-rose-500/15' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminBilling.billingAmpPayments')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminBilling.liveSubscriptionRevenueAcrossEveryFamily')}</p>
      </div>

      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: ROW_CEILING.toLocaleString() })}
        failures={trendCeiling ? [tr('adminBilling.newMrrAdded')] : []}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
              {'hint' in s && s.hint && <p className="mt-0.5 text-[11px] text-muted">{s.hint}</p>}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold">{tr('adminBilling.newMrrAdded')}</h2>
          {trendCeiling
            ? <p className="text-sm text-muted">{tr('strategyMetrics.unavailable')}</p>
            : <Bars data={trend} max={maxTrend} money />}
          <p className="mt-2 text-xs text-muted">{tr('adminBilling.monthlyEquivalentRevenueFromSubscriptionsStarted')}</p>
        </Card>
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminBilling.activeByPlan')}</h2>
          {planSegments.length === 0 ? (
            <EmptyState icon={CreditCard} title={tr('adminBilling.noActiveSubscriptions')} />
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={planSegments} total={payingCount} />
              <ul className="space-y-1.5 text-xs">
                {planSegments.map((s) => (
                  <li key={s.label} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="text-muted">{s.label}</span>
                    <span className="ml-auto font-semibold">{s.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-0">
        <h2 className="px-4 pt-4 text-base font-semibold">{tr('adminBilling.recentSubscriptions')}</h2>
        {recent.length === 0 ? (
          <div className="p-4"><EmptyState icon={RefreshCw} title={tr('adminBilling.noSubscriptionsYet')} description={tr('billing.subscriptionsAppearHereAsFamilies')} /></div>
        ) : (
          <div role="region" tabIndex={0} aria-label={tr('adminBilling.recentSubscriptions')} className="focus-ring mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.family')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.plan')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.status')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.estMonthly')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.started')}</th>
                  <th className="px-4 py-2.5 font-medium">{tr('adminBilling.renews')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {recent.map((s) => (
                  <tr key={s.id} className="hover:bg-surface/30">
                    <td className="px-4 py-3 font-medium">{familyName.get(s.family_id) ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{planName(s.plan)}</td>
                    <td className="px-4 py-3"><Badge tone={STATUS_TONE[s.status] ?? 'neutral'} className="capitalize">{s.status.replace('_', ' ')}</Badge></td>
                    <td className="px-4 py-3 font-medium">{fmtMoney(planMonthlyCents(s.plan))}</td>
                    <td className="px-4 py-3 text-muted">{fmtDate(s.created_at)}</td>
                    <td className="px-4 py-3 text-muted">{s.current_period_end ? fmtDate(s.current_period_end) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-center text-xs text-muted">
        {tr('adminBilling.managePlansAmpProcessorSettingsIn')} <Link href="/admin/subscriptions" className="text-brand-text underline hover:decoration-2">{tr('adminBilling.subscriptions')}</Link>{tr('adminBilling.refundsDisputesAndIndividualChargesAre')}
      </p>
    </div>
  );
}

async function AdminBillingReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Billing &amp; Payments</h1>
        <p className="mt-1 text-sm text-muted">{tr('billing.liveSubscriptionRevenueAcrossEvery')}</p>
      </div>
      <ErrorState message={tr('billing.couldNotLoadBillingData')} />
      <a href="/admin/billing" className="text-sm font-medium text-brand-text underline">{tr('billing.refreshBilling')}</a>
    </div>
  );
}
