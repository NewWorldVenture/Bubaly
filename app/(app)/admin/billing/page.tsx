import type { Metadata } from 'next';
import Link from 'next/link';
import { DollarSign, CreditCard, Users, RefreshCw, AlertCircle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle, settleAll } from '@/lib/supabase/settle';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Donut, Bars } from '@/components/admin/charts';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { planMonthlyCents, planName } from '@/lib/constants/plans';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Billing', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success', trialing: 'neutral', past_due: 'warning', unpaid: 'danger',
  canceled: 'neutral', incomplete: 'warning', incomplete_expired: 'danger',
};

const PLAN_COLORS = ['#7c5dff', '#22c55e', '#60a5fa', '#fbbf24', '#f87171', '#64748b'];

/** Exactly the columns the select below asks for, taken from the generated row. */
type SubscriptionRow = Pick<
  Tables<'subscriptions'>,
  'family_id' | 'plan' | 'status' | 'created_at' | 'current_period_end'
>;

export default async function AdminBillingPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  // Every figure on this page — Est. MRR, Active, Past Due, the plan donut, the
  // six-month trend and the recent list — is reduced from this ONE read, on a
  // page subtitled "live subscription revenue across every family". It was
  // unbounded, so PostgREST answered it with at most `db-max-rows` (1,000) and
  // said nothing, and it carried no `.order()`, so which thousand was arbitrary.
  // Past that, MRR was understated, "Past Due / Unpaid" could omit unpaid
  // accounts outright, and "recent" sorted an arbitrary thousand by created_at
  // and took ten — which need not contain a single genuinely recent row.
  //
  // Reaching the ceiling returns an error, which this page already turns into a
  // read-error state. On a revenue page, refusing to show a number beats showing
  // a smaller one with no way to tell.
  const [subscriptionsResult, billingCustomersResult] = await settleAll([
    readAllAsQuery<SubscriptionRow>((from, to) => supabase.from('subscriptions')
      .select('family_id, plan, status, created_at, current_period_end')
      .order('id').range(from, to), { max: 50_000 }),
    supabase.from('billing_customers').select('id', { count: 'exact', head: true }),
  ]);

  const readError = subscriptionsResult.error ?? billingCustomersResult.error;
  if (readError) {
    console.error('[admin-billing] billing read failed', readError);
    return <AdminBillingReadError />;
  }

  const { data: subs } = subscriptionsResult;
  const { count: billingCustomers } = billingCustomersResult;

  const rows = subs ?? [];
  const active = rows.filter((s) => s.status === 'active' || s.status === 'trialing');
  const mrrCents = active.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const pastDue = rows.filter((s) => s.status === 'past_due' || s.status === 'unpaid');

  // Plan distribution (active subs) — real.
  const planBuckets = new Map<string, number>();
  for (const s of active) planBuckets.set(planName(s.plan), (planBuckets.get(planName(s.plan)) ?? 0) + 1);
  const planSegments = [...planBuckets.entries()].map(([label, value], i) => ({ label, value, color: PLAN_COLORS[i % PLAN_COLORS.length] }));

  // New MRR added over the last 6 months — real, from subscription created_at.
  const trend = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - (5 - i), 1);
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const value = rows.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= start && t < end; })
      .reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
    return { label: d.toLocaleDateString('en-US', { month: 'short' }), value };
  });
  const maxTrend = Math.max(...trend.map((t) => t.value), 1);

  const recent = [...rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 10);

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
    { label: 'Active Subscriptions', value: active.length.toLocaleString(), icon: CreditCard, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Billing Customers', value: (billingCustomers ?? 0).toLocaleString(), icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Past Due / Unpaid', value: pastDue.length.toLocaleString(), icon: AlertCircle, tint: 'text-rose-400 bg-rose-500/15' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminBilling.billingAmpPayments')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminBilling.liveSubscriptionRevenueAcrossEveryFamily')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold">{tr('adminBilling.newMrrAdded')}</h2>
          <Bars data={trend} max={maxTrend} money />
          <p className="mt-2 text-xs text-muted">{tr('adminBilling.monthlyEquivalentRevenueFromSubscriptionsStarted')}</p>
        </Card>
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminBilling.activeByPlan')}</h2>
          {planSegments.length === 0 ? (
            <EmptyState icon={CreditCard} title={tr('adminBilling.noActiveSubscriptions')} />
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={planSegments} total={active.length} />
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
          <div className="mt-3 overflow-x-auto">
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
                {recent.map((s, i) => (
                  <tr key={`${s.family_id}-${i}`} className="hover:bg-surface/30">
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
        {tr('adminBilling.managePlansAmpProcessorSettingsIn')} <Link href="/admin/subscriptions" className="text-brand-text hover:underline">{tr('adminBilling.subscriptions')}</Link>{tr('adminBilling.refundsDisputesAndIndividualChargesAre')}
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
