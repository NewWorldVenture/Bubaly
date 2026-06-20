import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DollarSign, FileText, ShoppingCart, RotateCcw, CreditCard, Download, Plus,
  Receipt, Banknote, ArrowRight, ArrowUpRight, ArrowDownRight, Wallet, Settings,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { BigDonut, AreaChartSVG } from '@/components/admin/charts';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { planMonthlyCents, planName, PLANS } from '@/lib/constants/plans';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Billing & Payments', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = ['Overview', 'Transactions', 'Invoices', 'Plans & Pricing', 'Payment Methods', 'Refunds & Disputes', 'Tax Settings'] as const;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const MS_DAY = 86_400_000;
const tier = (p: string | null) => (p === 'family_annual' ? 'Premium' : p === 'family' ? 'Basic' : 'Free');

type SP = { searchParams: Promise<{ tab?: string }> };

export default async function AdminBillingPage({ searchParams }: SP) {
  const sp = await searchParams;
  const activeTab = TABS.find((t) => slug(t) === sp.tab) ?? 'Overview';
  const supabase = createServiceClient();

  const [{ data: subs }, { data: families }] = await Promise.all([
    supabase.from('subscriptions').select('id, family_id, plan, status, created_at, current_period_end'),
    supabase.from('families').select('id, name'),
  ]);
  const nameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const allSubs = subs ?? [];
  const active = allSubs.filter((s) => s.status === 'active');
  const failed = allSubs.filter((s) => ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(s.status));

  const mrrCents = active.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const outstandingCents = allSubs.filter((s) => s.status === 'past_due').reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const overdueCents = allSubs.filter((s) => s.status === 'unpaid').reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);

  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime();
  const d = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0);
  const newThis = active.filter((s) => new Date(s.created_at).getTime() >= monthStart).length;
  const newLast = active.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= lastMonthStart && t < monthStart; }).length;

  const stats = [
    { icon: DollarSign, tint: 'text-emerald-400 bg-emerald-500/15', label: 'Total Revenue', value: fmtMoney(mrrCents), delta: d(newThis, newLast) },
    { icon: FileText, tint: 'text-blue-400 bg-blue-500/15', label: 'MRR', value: fmtMoney(mrrCents), delta: d(newThis, newLast) },
    { icon: ShoppingCart, tint: 'text-violet-400 bg-violet-500/15', label: 'Subscriptions', value: allSubs.length.toLocaleString(), delta: d(newThis, newLast) },
    { icon: RotateCcw, tint: 'text-amber-400 bg-amber-500/15', label: 'Refunds', value: fmtMoney(0), delta: 0 },
    { icon: CreditCard, tint: 'text-rose-400 bg-rose-500/15', label: 'Failed Payments', value: failed.length.toLocaleString(), delta: 0 },
  ];

  // Cumulative MRR over the last 30 days (subscriptions accumulate as they start).
  const revenueSeries = Array.from({ length: 30 }, (_, i) => {
    const dayEnd = now - (29 - i) * MS_DAY + MS_DAY;
    const cents = active.filter((s) => new Date(s.created_at).getTime() < dayEnd).reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
    return { label: new Date(now - (29 - i) * MS_DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: Math.round(cents / 100) };
  });

  // Revenue by plan tier
  const tierMrr = { Premium: 0, Basic: 0, Free: 0 } as Record<string, number>;
  for (const s of active) tierMrr[tier(s.plan)] += planMonthlyCents(s.plan);
  const planSegments = [
    { label: 'Premium (Annual)', value: tierMrr.Premium, color: '#7c5dff' },
    { label: 'Basic (Monthly)', value: tierMrr.Basic, color: '#3b82f6' },
    { label: 'Free', value: tierMrr.Free, color: '#64748b' },
  ];

  // Subscription status breakdown (stands in for payment-method data, which lives in Stripe)
  const statusCounts: Record<string, number> = {};
  for (const s of allSubs) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  const statusColors: Record<string, string> = { active: '#22c55e', trialing: '#7c5dff', past_due: '#f59e0b', unpaid: '#ef4444', canceled: '#64748b' };
  const statusSegments = Object.entries(statusCounts).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v, color: statusColors[k] ?? '#64748b' }));

  const recent = [...allSubs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 8);

  return (
    <div className="module-page space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Billing &amp; Payments</h1>
          <p className="mt-1 text-sm text-muted">Manage billing, payments, invoices, and financial transactions.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/reports" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/40 px-3.5 py-2 text-sm font-medium hover:bg-elevated"><Download className="h-4 w-4" /> Download Statement</Link>
          <Link href="/admin/subscriptions" className="btn-cta"><Plus className="h-4 w-4" /> Create Invoice</Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/billing?tab=${slug(t)}`} className={cn('border-b-2 px-3 py-2 text-sm font-medium transition', activeTab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>{t}</Link>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-2">
            <span className={cn('inline-flex h-10 w-10 items-center justify-center rounded-xl', s.tint)}><s.icon className="h-5 w-5" /></span>
            <p className="text-xs text-muted">{s.label}</p>
            <p className="text-xl font-bold leading-none">{s.value}</p>
            <p className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold', s.delta >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
              {s.delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{Math.abs(s.delta)}% vs last 30 days
            </p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {activeTab === 'Overview' && (
            <>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-1">
                  <p className="text-sm font-semibold">Revenue Over Time</p>
                  <p className="mt-1 text-xl font-bold">{fmtMoney(mrrCents)}</p>
                  <p className="text-xs text-muted">Cumulative MRR · last 30 days</p>
                  <div className="mt-2"><AreaChartSVG points={revenueSeries} money height={150} /></div>
                </Card>
                <Card>
                  <p className="mb-2 text-sm font-semibold">Revenue by Plan</p>
                  <div className="flex items-center gap-3">
                    <BigDonut segments={planSegments} centerTop={fmtMoney(mrrCents)} centerBottom="MRR" size={130} />
                    <ul className="flex-1 space-y-1.5 text-xs">
                      {planSegments.map((s) => (
                        <li key={s.label} className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                          <span className="text-muted">{s.label}</span>
                          <span className="ml-auto font-semibold">{fmtMoney(s.value)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
                <Card>
                  <p className="mb-2 text-sm font-semibold">Billing Status</p>
                  {statusSegments.length === 0 ? <EmptyState icon={CreditCard} title="No subscriptions" /> : (
                    <div className="flex items-center gap-3">
                      <BigDonut segments={statusSegments} centerTop={String(allSubs.length)} centerBottom="Subs" size={130} />
                      <ul className="flex-1 space-y-1.5 text-xs">
                        {statusSegments.map((s) => (
                          <li key={s.label} className="flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                            <span className="capitalize text-muted">{s.label}</span>
                            <span className="ml-auto font-semibold">{s.value}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>
              </div>
              <TransactionsTable recent={recent} nameById={nameById} title="Recent Transactions" />
            </>
          )}

          {activeTab === 'Transactions' && <TransactionsTable recent={[...allSubs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())} nameById={nameById} title="All Transactions" />}

          {activeTab === 'Invoices' && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Invoices</h2>
              {allSubs.length === 0 ? <EmptyState icon={Receipt} title="No invoices yet" /> : (
                <ul className="divide-y divide-border">
                  {allSubs.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 py-2.5">
                      <Receipt className="h-4 w-4 text-muted" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{nameById.get(s.family_id) ?? 'Family'}</p>
                        <p className="text-xs text-muted">{planName(s.plan)} · {fmtDate(s.created_at)}</p>
                      </div>
                      <span className="text-sm font-semibold">{fmtMoney(planMonthlyCents(s.plan))}</span>
                      <StatusPill status={s.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {activeTab === 'Plans & Pricing' && (
            <div className="grid gap-4 sm:grid-cols-3">
              {PLANS.map((p) => (
                <Card key={p.id} className={cn(p.featured && 'border-brand/40')}>
                  <p className="text-sm font-semibold">{p.name}</p>
                  <p className="mt-1 text-2xl font-bold">{p.priceMonthly === 0 ? 'Free' : fmtMoney(p.priceMonthly)}<span className="text-xs font-normal text-muted">/mo</span></p>
                  <p className="mt-1 text-xs text-muted">{p.tagline}</p>
                  <p className="mt-2 text-xs text-muted">{active.filter((s) => tier(s.plan) === tier(p.id) || s.plan === p.id).length} active</p>
                  <ul className="mt-3 space-y-1 text-xs text-muted">{p.features.slice(0, 4).map((f) => <li key={f}>• {f}</li>)}</ul>
                </Card>
              ))}
            </div>
          )}

          {(activeTab === 'Payment Methods' || activeTab === 'Refunds & Disputes' || activeTab === 'Tax Settings') && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">{activeTab}</h2>
              <p className="text-sm text-muted">
                {activeTab === 'Payment Methods' && 'Card and payout details are held securely by Stripe and never stored in FamilyOS. Manage them from the Stripe billing portal.'}
                {activeTab === 'Refunds & Disputes' && 'Refunds and chargeback disputes are processed through Stripe. Issue and track them from the Stripe dashboard.'}
                {activeTab === 'Tax Settings' && 'Tax rates and registrations are configured in Stripe Tax and applied automatically at checkout.'}
              </p>
              <Link href="https://dashboard.stripe.com" target="_blank" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">Open Stripe dashboard <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Card>
          )}
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">Billing Summary</h2><span className="rounded-lg border border-border px-2 py-0.5 text-xs text-muted">This Month</span></div>
            <ul className="space-y-2.5 text-sm">
              {[
                { icon: Banknote, color: 'text-emerald-400', label: 'Total Billed', value: fmtMoney(mrrCents) },
                { icon: DollarSign, color: 'text-emerald-400', label: 'Total Collected', value: fmtMoney(mrrCents - outstandingCents - overdueCents) },
                { icon: Receipt, color: 'text-amber-400', label: 'Outstanding', value: fmtMoney(outstandingCents) },
                { icon: RotateCcw, color: 'text-rose-400', label: 'Overdue', value: fmtMoney(overdueCents) },
              ].map((r) => (
                <li key={r.label} className="flex items-center gap-3"><r.icon className={cn('h-4 w-4', r.color)} /><span className="flex-1 text-muted">{r.label}</span><span className="font-semibold">{r.value}</span></li>
              ))}
            </ul>
            <Link href="/admin/reports" className="mt-3 block text-center text-xs font-medium text-brand hover:underline">View full summary →</Link>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">Recent Invoices</h2><Link href="/admin/billing?tab=invoices" className="text-xs font-medium text-brand hover:underline">View all</Link></div>
            {recent.length === 0 ? <EmptyState icon={Receipt} title="No invoices" /> : (
              <ul className="space-y-1">
                {recent.slice(0, 5).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                    <FileText className="h-4 w-4 text-muted" />
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{nameById.get(s.family_id) ?? 'Family'}</p><p className="text-xs text-muted">{fmtDate(s.created_at)}</p></div>
                    <div className="text-right"><p className="text-sm font-semibold">{fmtMoney(planMonthlyCents(s.plan))}</p><StatusPill status={s.status} /></div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
            <ul className="space-y-1">
              {[
                { icon: Receipt, label: 'Create Invoice', href: '/admin/subscriptions' },
                { icon: Banknote, label: 'Record Payment', href: '/admin/subscriptions' },
                { icon: RotateCcw, label: 'Issue Refund', href: 'https://dashboard.stripe.com' },
                { icon: Wallet, label: 'Manage Payment Methods', href: 'https://dashboard.stripe.com' },
                { icon: Settings, label: 'View Billing Settings', href: '/admin/settings' },
              ].map((a) => (
                <li key={a.label}><Link href={a.href} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-elevated"><a.icon className="h-4 w-4 text-brand" /><span className="flex-1">{a.label}</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-500/15 text-emerald-300', trialing: 'bg-violet-500/15 text-violet-300',
    past_due: 'bg-amber-500/15 text-amber-300', unpaid: 'bg-rose-500/15 text-rose-300',
    canceled: 'bg-white/10 text-muted',
  };
  const label: Record<string, string> = { active: 'Paid', trialing: 'Trial', past_due: 'Pending', unpaid: 'Overdue', canceled: 'Canceled' };
  return <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize', map[status] ?? 'bg-white/10 text-muted')}>{label[status] ?? status.replace(/_/g, ' ')}</span>;
}

function TransactionsTable({ recent, nameById, title }: {
  recent: { id: string; family_id: string; plan: string; status: string; created_at: string }[];
  nameById: Map<string, string>; title: string;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <Link href="/admin/billing?tab=transactions" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">View all <ArrowRight className="h-3 w-3" /></Link>
      </div>
      {recent.length === 0 ? <EmptyState icon={ShoppingCart} title="No transactions yet" /> : (
        <div className="table-responsive">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted">
              <th className="pb-2 pr-3 font-medium">Transaction ID</th><th className="pb-2 pr-3 font-medium">Date</th>
              <th className="pb-2 pr-3 font-medium">Customer / Family</th><th className="pb-2 pr-3 font-medium">Plan</th>
              <th className="pb-2 pr-3 font-medium">Amount</th><th className="pb-2 font-medium">Status</th>
            </tr></thead>
            <tbody>
              {recent.slice(0, 25).map((s) => (
                <tr key={s.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2.5 pr-3 font-mono text-xs">TXN-{s.id.slice(0, 8)}</td>
                  <td className="py-2.5 pr-3 text-xs text-muted">{fmtDate(s.created_at, 'MMM d, yyyy h:mm a')}</td>
                  <td className="py-2.5 pr-3">{nameById.get(s.family_id) ?? 'Family'}</td>
                  <td className="py-2.5 pr-3 text-muted">{planName(s.plan)}</td>
                  <td className="py-2.5 pr-3 font-semibold">{fmtMoney(planMonthlyCents(s.plan))}</td>
                  <td className="py-2.5"><StatusPill status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
