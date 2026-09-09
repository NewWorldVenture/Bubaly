import type { Metadata } from 'next';
import { CreditCard, Users, DollarSign, TrendingDown, ExternalLink, Receipt } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { getStripe } from '@/lib/stripe';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PLANS, type Plan } from '@/lib/constants/plans';
import { fmtDate, fmtMoney } from '@/lib/utils/format';
import { GrowthChart } from '@/components/admin/growth-chart';
import { describeDbError } from '@/lib/supabase/errors';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Subscriptions', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'plans', label: 'Plans' },
  { key: 'all', label: 'All Subscriptions' },
  { key: 'billing', label: 'Billing History' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Params = { searchParams: Promise<{ tab?: string }> };

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

  const [subscriptionsResult, familiesResult, billingCustomersResult] = await settleAll([
    supabase.from('subscriptions').select('*').order('created_at', { ascending: false }),
    supabase.from('families').select('id, name'),
    supabase.from('billing_customers').select('family_id, customer_ref'),
  ]);

  const readError = subscriptionsResult.error ?? familiesResult.error ?? billingCustomersResult.error;
  if (readError) {
    console.error('[admin-subscriptions] subscription read failed', readError);
    return <AdminSubscriptionsReadError tab={tab} />;
  }

  const { data: subscriptions } = subscriptionsResult;
  const { data: families } = familiesResult;
  const { data: billingCustomers } = billingCustomersResult;

  const subs = subscriptions ?? [];
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const customerToFamily = new Map((billingCustomers ?? []).filter((b) => b.customer_ref).map((b) => [b.customer_ref as string, b.family_id]));

  const planById = (id: string): Plan | undefined => PLANS.find((p) => p.id === id);
  const activeSubs = subs.filter((s) => s.status === 'active');
  const countsByPlan = new Map<string, number>();
  for (const s of activeSubs) countsByPlan.set(s.plan, (countsByPlan.get(s.plan) ?? 0) + 1);

  const mrr = activeSubs.reduce((sum, s) => sum + (planById(s.plan)?.priceMonthly ?? 0), 0);
  const arr = mrr * 12;

  const since30 = new Date(Date.now() - 30 * 86400000);
  const canceledRecently = subs.filter((s) => s.status === 'canceled' && new Date(s.updated_at) >= since30).length;
  const churnBase = activeSubs.length + canceledRecently;
  const churnRate = churnBase > 0 ? (canceledRecently / churnBase) * 100 : 0;

  // Real Stripe invoices (account-wide, no per-customer fan-out). Gracefully empty if Stripe isn't configured.
  let invoices: { id: string; number: string | null; amountPaid: number; status: string; created: number; familyName: string; hostedUrl: string | null }[] = [];
  let stripeError: string | null = null;
  if (tab === 'billing') {
    try {
      const stripe = getStripe();
      const list = await stripe.invoices.list({ limit: 20 });
      invoices = list.data.map((inv) => {
        const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        const familyId = customerId ? customerToFamily.get(customerId) : undefined;
        return {
          id: inv.id ?? '', number: inv.number, amountPaid: inv.amount_paid, status: inv.status ?? 'unknown',
          created: inv.created, familyName: familyId ? familyNameById.get(familyId) ?? 'Unknown family' : 'Unknown family',
          hostedUrl: inv.hosted_invoice_url ?? null,
        };
      });
    } catch (err) {
      stripeError = describeDbError(err, tr('subscriptions.stripeIsNotConfigured'));
    }
  }

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
          <div className="grid gap-4 sm:grid-cols-3">
            {PLANS.map((p) => (
              <Card key={p.id} className={p.featured ? 'ring-2 ring-brand' : undefined}>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">{p.name}</h3>
                  {p.featured && <Badge tone="brand">{tr('subscriptions.popular')}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted">{p.tagline}</p>
                <p className="mt-3 text-2xl font-bold">{p.priceMonthly === 0 ? 'Free' : fmtMoney(p.priceMonthly)}<span className="text-sm font-normal text-muted">{p.priceMonthly > 0 && '/mo'}</span></p>
                <p className="mt-1 text-xs text-muted">{p.seats === 'Unlimited' ? 'Unlimited members' : `Up to ${p.seats} members`}</p>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm font-medium">{(countsByPlan.get(p.id) ?? 0).toLocaleString()} active</span>
                  <a href={`/admin/users?tab=all&plan=${p.id}`} className="text-xs font-medium text-brand-text hover:underline">{tr('subscriptions.viewSubscribers')}</a>
                </div>
              </Card>
            ))}
          </div>

          <div className="grid-stats">
            <StatCard icon={Users} label={tr('adminSubscriptions.activeSubscriptions')} value={activeSubs.length.toLocaleString()} tone="bg-brand/10 text-brand-text" />
            <StatCard icon={DollarSign} label="MRR" value={fmtMoney(mrr)} tone="bg-success/10 text-success" />
            <StatCard icon={DollarSign} label="ARR" value={fmtMoney(arr)} tone="bg-accent/10 text-accent" />
            <StatCard icon={TrendingDown} label={tr('adminSubscriptions.churn30d')} value={`${churnRate.toFixed(1)}%`} tone="bg-danger/10 text-danger" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <Card>
              <h2 className="mb-4 text-base font-semibold">{tr('adminSubscriptions.subscriptionsOverTime')} <span className="text-muted">{tr('adminSubscriptions.last30Days')}</span></h2>
              <GrowthChart timestamps={subs.map((s) => s.created_at)} />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminSubscriptions.byPlan')}</h2>
              <PlanDonut counts={countsByPlan} total={activeSubs.length} />
            </Card>
          </div>

          <Card>
            <h2 className="mb-4 text-base font-semibold">{tr('adminSubscriptions.recentSubscriptions')}</h2>
            {subs.length === 0 ? (
              <EmptyState icon={CreditCard} title={tr('adminSubscriptions.noSubscriptionsYet')} />
            ) : (
              <ul className="space-y-2">
                {subs.slice(0, 8).map((s) => (
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
                    <a href={inv.hostedUrl} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">{tr('subscriptions.view')}{' '}<ExternalLink className="h-3.5 w-3.5" />
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
