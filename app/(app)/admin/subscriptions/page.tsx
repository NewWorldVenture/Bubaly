import type { Metadata } from 'next';
import { CreditCard, Users, DollarSign, TrendingDown, ExternalLink, Receipt } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import type Stripe from 'stripe';
import { stripeFromKey } from '@/lib/stripe';
import { resolveStripeSecretKey } from '@/lib/stripe/settings';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PLANS, type Plan } from '@/lib/constants/plans';
import { fmtDate, fmtMoney } from '@/lib/utils/format';
import { GrowthChart } from '@/components/admin/growth-chart';
import { describeActionError } from '@/lib/supabase/errors';
import { getTranslations } from '@/lib/i18n/server';
import { safeWebLink } from '@/lib/utils/safe-link';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { lastUtcDays } from '@/lib/admin/clock';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('subscriptions.subscriptions'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'plans', label: 'Plans' },
  { key: 'all', label: 'All Subscriptions' },
  { key: 'billing', label: 'Billing History' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Params = { searchParams: Promise<{ tab?: string }> };

/** Rows a paged read may go through before it is reported as a prefix (one round trip per 1,000). */
const ROW_CEILING = 25_000;
/** The Plans tab lists this many of the newest subscriptions. */
const RECENT_SHOWN = 8;

async function PlanDonut({ counts, total }: { counts: Map<string, number>; total: number }) {
  const tr = await getTranslations();
  const colors = ['#94a3b8', '#a78bfa', '#fbbf24'];
  const circ = 2 * Math.PI * 40;
  let offset = 0;
  const arcs = PLANS.map((p, i) => {
    const count = counts.get(p.id) ?? 0;
    const dash = total > 0 ? (count / total) * circ : 0;
    const arc = { plan: p, count, dash, offset, color: colors[i % colors.length] };
    offset += dash;
    return arc;
  }).filter((a) => a.count > 0);

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
          {arcs.map((a) => (
            <circle key={a.plan.id} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="14"
              strokeDasharray={`${a.dash} ${circ}`} strokeDashoffset={-a.offset} />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-black">{total.toLocaleString()}</span>
          <span className="text-[9px] text-muted">{tr('subscriptions.total')}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 text-sm">
        {PLANS.map((p, i) => {
          const count = counts.get(p.id) ?? 0;
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
          return (
            <li key={p.id} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors[i % colors.length] }} />
              <span className="flex-1 truncate text-muted">{p.name}</span>
              <span className="font-medium">{count.toLocaleString()} ({pct}%)</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function AdminSubscriptionsPage({ searchParams }: Params) {
  const tr = await getTranslations();
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'plans';
  const supabase = createServiceClient();

  // Every revenue figure here used to be reduced from ONE unbounded
  // `subscriptions.select('*')`, newest first. PostgREST answers that with at
  // most `db-max-rows` (1,000) and no error, so past a thousand subscriptions
  // MRR, ARR, the plan donut, the active count and the churn rate were computed
  // over the newest thousand — and the OLDEST rows, where the cancelled
  // accounts that feed churn live, were the ones dropped. The unbounded
  // `families` read beside it labelled any family past the thousandth "Unknown
  // family".
  //
  // The tiles are now `head: true` counts — exact, uncapped — and MRR is the
  // per-plan active counts times the plan prices, which is the same sum without
  // reading a row.
  //
  // Each tab reads only what it shows (review
  // R5-SIB-SUBSCRIPTION-ROWS-LOCK-PLANS-AND-BILLING). Every subscription row
  // used to be read on every tab, paged to a 25,000-row ceiling with reaching
  // it an error, so past 25,000 subscriptions Plans and Billing were the
  // read-error state too, for rows neither of them lists:
  //   - Plans: the tiles' counts; the growth chart drawn as /admin/system draws
  //     its own, from one count of the subscriptions created before its first
  //     day and only the rows inside it; and the newest RECENT_SHOWN rows. Past
  //     the ceiling inside the chart's thirty days the chart alone says it is
  //     not shown;
  //   - All: every subscription, which is what the tab lists, so its ceiling
  //     is still the tab's read-error state;
  //   - Billing: no subscription row; it lists Stripe's invoices.
  // The paged reads go on the id, not on offsets: a checkout between two pages
  // shifted every later offset by one and listed or drew one subscription twice.
  //
  // The family names only label rows, so each listed row is named from its own
  // family, below (review R5-FAMILIES-LABEL-CEILING-LOCKS-PAGES).
  const onPlans = tab === 'plans';
  const notRead = Promise.resolve({ data: null, count: null, error: null, truncated: false } as const);
  const since30 = new Date(Date.now() - 30 * 86400000);
  // The growth chart's first day (lib/admin/clock.ts).
  const chartStart = new Date(lastUtcDays(30)[0].start).toISOString();
  const [
    [activeCountResult, canceledRecentlyResult, chartBaseResult, recentResult, chartResult, subscriptionsResult],
    planCountResults,
  ] = await Promise.all([
    settleAll([
      onPlans ? supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active') : notRead,
      onPlans ? supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'canceled').gte('updated_at', since30.toISOString()) : notRead,
      onPlans ? supabase.from('subscriptions').select('id', { count: 'exact', head: true }).lt('created_at', chartStart) : notRead,
      onPlans ? supabase.from('subscriptions').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(RECENT_SHOWN) : notRead,
      onPlans ? readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('subscriptions').select('id, created_at').gte('created_at', chartStart);
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING }) : notRead,
      tab === 'all' ? readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('subscriptions').select('*');
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING }) : notRead,
    ]),
    settleAll(onPlans ? PLANS.map((p) =>
      supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('plan', p.id)) : []),
  ]);

  // The chart's rows past the ceiling cost the chart, not the tiles and the
  // recent rows beside it. Any other failure is still the read-error state.
  const chartCeiling = 'truncated' in chartResult && chartResult.truncated;
  if (chartCeiling) console.warn('[admin-subscriptions] the growth chart read reached its ceiling; the chart is not shown');
  const readError = subscriptionsResult.error ?? (chartCeiling ? null : chartResult.error)
    ?? activeCountResult.error ?? canceledRecentlyResult.error ?? chartBaseResult.error ?? recentResult.error
    ?? planCountResults.find((r) => r.error)?.error;
  if (readError) {
    console.error('[admin-subscriptions] subscription read failed', readError);
    return <AdminSubscriptionsReadError tab={tab} />;
  }

  // Newest first, as the All tab has always listed them; the paged read was ordered by id.
  const subs = [...(subscriptionsResult.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const recentSubs = recentResult.data ?? [];

  const planById = (id: string): Plan | undefined => PLANS.find((p) => p.id === id);
  const activeCount = activeCountResult.count ?? 0;
  // Read on Plans only; the other tabs show no count.
  const countsByPlan = new Map<string, number>(PLANS.map((p, i) => [p.id, planCountResults[i]?.count ?? 0]));

  const mrr = PLANS.reduce((sum, p) => sum + (countsByPlan.get(p.id) ?? 0) * p.priceMonthly, 0);
  const arr = mrr * 12;

  const canceledRecently = canceledRecentlyResult.count ?? 0;
  const churnBase = activeCount + canceledRecently;
  const churnRate = churnBase > 0 ? (canceledRecently / churnBase) * 100 : 0;

  // Real Stripe invoices (account-wide, no per-customer fan-out). Gracefully empty if Stripe isn't configured.
  let listed: Stripe.Invoice[] = [];
  let stripeError: string | null = null;
  let customerToFamily = new Map<string, string>();
  const customerOf = (inv: Stripe.Invoice) => (typeof inv.customer === 'string' ? inv.customer : inv.customer?.id);
  if (tab === 'billing') {
    // Listed through the key billing uses: Stripe Setup's, then the
    // environment's (resolveStripeSecretKey). getStripe() read the environment
    // alone, so a key saved only in Stripe Setup read "Stripe is not
    // configured" while checkout worked, and a stale environment key listed
    // another account's invoices. Unread settings are not the environment's.
    const resolved = await resolveStripeSecretKey();
    if (resolved.status === 'unreadable') {
      console.error('[admin-subscriptions] stripe settings read failed', resolved.error);
      stripeError = tr('adminIntegrations.stripeSetupUnreadable');
    } else if (resolved.status === 'none') {
      stripeError = tr('adminIntegrations.stripeNoKey');
    } else {
      try {
        listed = (await stripeFromKey(resolved.key).invoices.list({ limit: 20 })).data;
      } catch (err) {
        console.error('[admin-subscriptions] stripe invoice list failed', err);
        stripeError = describeActionError(err, tr('adminSubscriptions.stripeInvoicesUnavailable'));
      }
    }
    // Only the customers these invoices name. The whole billing_customers table
    // was read unbounded, which PostgREST answers with at most `db-max-rows`
    // (1,000) rows, so an invoice whose customer fell past them read "Unknown
    // family".
    const customerRefs = [...new Set(listed.map(customerOf).filter((ref): ref is string => !!ref))];
    const billingCustomersResult = await readInChunks(customerRefs, (chunk) =>
      supabase.from('billing_customers').select('family_id, customer_ref').in('customer_ref', chunk));
    if (billingCustomersResult.error) {
      console.error('[admin-subscriptions] billing customer read failed', billingCustomersResult.error);
      return <AdminSubscriptionsReadError tab={tab} />;
    }
    customerToFamily = new Map(billingCustomersResult.data.filter((b) => b.customer_ref).map((b) => [b.customer_ref as string, b.family_id]));
  }
  const familyOfInvoice = (inv: Stripe.Invoice) => {
    const customerId = customerOf(inv);
    return customerId ? customerToFamily.get(customerId) : undefined;
  };

  // Only the families this tab names: the recent subscriptions, every listed
  // subscription, or the invoices' families, which need not have a
  // subscription row at all.
  const labelledFamilyIds = tab === 'plans' ? recentSubs.map((s) => s.family_id)
    : tab === 'all' ? subs.map((s) => s.family_id)
    : listed.map(familyOfInvoice).filter((id): id is string => !!id);
  const familiesResult = await readInChunks([...new Set(labelledFamilyIds)], (chunk) =>
    supabase.from('families').select('id, name').in('id', chunk));
  if (familiesResult.error) {
    console.error('[admin-subscriptions] family name read failed', familiesResult.error);
    return <AdminSubscriptionsReadError tab={tab} />;
  }
  const familyNameById = new Map(familiesResult.data.map((f) => [f.id, f.name]));

  const invoices = listed.map((inv) => {
    const familyId = familyOfInvoice(inv);
    return {
      id: inv.id ?? '', number: inv.number, amountPaid: inv.amount_paid, status: inv.status ?? 'unknown',
      created: inv.created, familyName: familyId ? familyNameById.get(familyId) ?? 'Unknown family' : 'Unknown family',
      hostedUrl: inv.hosted_invoice_url ?? null,
    };
  });

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminSubscriptions.subscriptions')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminSubscriptions.manageSubscriptionPlansPricingAndCustomer')}</p>
      </div>

      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/subscriptions?tab=${t.key}`} className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {tab === 'plans' && (
        <>
          <PartialReadBanner
            title={tr('adminCeiling.figuresNotShown', { n: ROW_CEILING.toLocaleString() })}
            failures={chartCeiling ? [tr('adminSubscriptions.subscriptionsOverTime')] : []}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            {PLANS.map((p) => (
              <Card key={p.id} className={p.featured ? 'ring-2 ring-brand' : undefined}>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">{p.name}</h3>
                  {p.featured && <Badge tone="brand">{tr('subscriptions.popular')}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted">{p.tagline}</p>
                <p className="mt-3 text-2xl font-bold">{p.priceMonthly === 0 ? 'Free' : fmtMoney(p.priceMonthly)}<span className="text-sm font-normal text-muted">{p.priceMonthly > 0 && '/mo'}</span></p>
                <p className="mt-1 text-xs text-muted">{p.seats === 'Unlimited' ? tr('adminSubscriptions.unlimitedMembers') : tr('adminSubscriptions.upToMembers', { n: p.seats })}</p>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm font-medium">{(countsByPlan.get(p.id) ?? 0).toLocaleString()} active</span>
                  <a href={`/admin/users?tab=all&plan=${p.id}`} className="text-xs font-medium text-brand-text hover:underline">{tr('subscriptions.viewSubscribers')}</a>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid-stats">
            <StatCard icon={Users} label={tr('adminSubscriptions.activeSubscriptions')} value={activeCount.toLocaleString()} tone="bg-brand/10 text-brand-text" />
            <StatCard icon={DollarSign} label="MRR" value={fmtMoney(mrr)} tone="bg-success/10 text-success" />
            <StatCard icon={DollarSign} label="ARR" value={fmtMoney(arr)} tone="bg-accent/10 text-accent" />
            <StatCard icon={TrendingDown} label={tr('adminSubscriptions.churn30d')} value={`${churnRate.toFixed(1)}%`} tone="bg-danger/10 text-danger" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card>
              <h2 className="mb-4 text-base font-semibold">{tr('adminSubscriptions.subscriptionsOverTime')} <span className="text-muted">{tr('adminSubscriptions.last30Days')}</span></h2>
              {chartCeiling
                ? <p className="text-sm text-muted">{tr('strategyMetrics.unavailable')}</p>
                : <GrowthChart timestamps={(chartResult.data ?? []).map((s) => s.created_at)} base={chartBaseResult.count ?? 0} />}
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminSubscriptions.byPlan')}</h2>
              <PlanDonut counts={countsByPlan} total={activeCount} />
            </Card>
          </div>

          <Card>
            <h2 className="mb-4 text-base font-semibold">{tr('adminSubscriptions.recentSubscriptions')}</h2>
            {recentSubs.length === 0 ? (
              <EmptyState icon={CreditCard} title={tr('adminSubscriptions.noSubscriptionsYet')} />
            ) : (
              <ul className="space-y-2">
                {recentSubs.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-sm">
                    <span className="font-medium">{familyNameById.get(s.family_id) ?? 'Unknown family'}</span>
                    <Badge tone="neutral">{planById(s.plan)?.name ?? s.plan}</Badge>
                    <Badge tone={s.status === 'active' ? 'success' : s.status === 'past_due' ? 'danger' : 'neutral'}>{s.status}</Badge>
                    <span className="ml-auto text-xs text-muted">{fmtDate(s.created_at, 'MMM d, yyyy')}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {tab === 'all' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">{tr('adminSubscriptions.allSubscriptions')} <span className="text-muted">({subs.length})</span></h2>
          {subs.length === 0 ? (
            <EmptyState icon={CreditCard} title={tr('adminSubscriptions.noSubscriptionsYet')} />
          ) : (
            <div className="table-responsive">
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.family')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.plan')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.status')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.seats')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.renews')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminSubscriptions.started')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {subs.map((s) => (
                    <tr key={s.id}>
                      <td className="px-3 py-2.5 font-medium">{familyNameById.get(s.family_id) ?? 'Unknown family'}</td>
                      <td className="px-3 py-2.5 text-muted">{planById(s.plan)?.name ?? s.plan}</td>
                      <td className="px-3 py-2.5"><Badge tone={s.status === 'active' ? 'success' : s.status === 'past_due' ? 'danger' : 'neutral'}>{s.status}</Badge></td>
                      <td className="px-3 py-2.5 text-muted">{s.seats}</td>
                      <td className="px-3 py-2.5 text-muted">{s.current_period_end ? fmtDate(s.current_period_end, 'MMM d, yyyy') : '—'}</td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(s.created_at, 'MMM d, yyyy')}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </Card>
      )}

      {tab === 'billing' && (
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted" />
            <h2 className="text-base font-semibold">{tr('adminSubscriptions.recentInvoicesDirectFromStripe')}</h2>
          </div>
          {stripeError ? (
            <EmptyState icon={Receipt} title={tr('adminSubscriptions.stripeIsntConnected')} description={stripeError} />
          ) : invoices.length === 0 ? (
            <EmptyState icon={Receipt} title={tr('adminSubscriptions.noInvoicesYet')} />
          ) : (
            <ul className="space-y-2">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-sm">
                  <span className="font-medium">{inv.familyName}</span>
                  <span className="text-muted">{inv.number ?? inv.id}</span>
                  <Badge tone={inv.status === 'paid' ? 'success' : inv.status === 'open' ? 'warning' : 'neutral'}>{inv.status}</Badge>
                  <span className="font-medium">{fmtMoney(inv.amountPaid)}</span>
                  <span className="text-xs text-muted">{fmtDate(new Date(inv.created * 1000).toISOString(), 'MMM d, yyyy')}</span>
                  {inv.hostedUrl && (
                    <a href={safeWebLink(inv.hostedUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">{tr('subscriptions.view')}{' '}<ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

async function AdminSubscriptionsReadError({ tab }: { tab: TabKey }) {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('subscriptions.subscriptions')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('subscriptions.manageSubscriptionPlansPricingAnd')}</p>
      </div>
      <ErrorState message={tr('subscriptions.couldNotLoadSubscriptionData')} />
      <a href={`/admin/subscriptions?tab=${tab}`} className="text-sm font-medium text-brand-text underline">{tr('subscriptions.refreshSubscriptions')}</a>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
