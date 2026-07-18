import type { Metadata } from 'next';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Bars } from '@/components/admin/charts';
import { fmtMoney } from '@/lib/utils/format';
import { getMarketingCustomersWithError, summarizeCustomers } from '@/lib/marketing/customers';
import { planMonthlyCents } from '@/lib/constants/plans';

export const metadata: Metadata = { title: 'Marketing · Analytics', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const supabase = createServiceClient();
  const [customersResult, campaignsResult, emailsResult] = await Promise.all([
    getMarketingCustomersWithError(supabase),
    supabase.from('marketing_campaigns').select('channel, status, budget_cents').is('deleted_at', null),
    supabase.from('marketing_email_campaigns').select('recipients, opens, clicks, status').is('deleted_at', null),
  ]);
  const readError = customersResult.error ?? campaignsResult.error ?? emailsResult.error;
  if (readError) {
    console.error('[admin-marketing-analytics] analytics read failed', readError);
    return <MarketingAnalyticsReadError />;
  }
  const { customers } = customersResult;
  const { data: campaigns } = campaignsResult;
  const { data: emails } = emailsResult;
  const m = summarizeCustomers(customers);

  // Customer acquisition — last 6 months from real family.created_at.
  const acq = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - (5 - i), 1);
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const value = customers.filter((c) => { const t = new Date(c.createdAt).getTime(); return t >= start && t < end; }).length;
    return { label: d.toLocaleDateString('en-US', { month: 'short' }), value };
  });
  const maxAcq = Math.max(...acq.map((a) => a.value), 1);

  // Channel mix from real campaigns.
  const byChannel = new Map<string, { count: number; budget: number }>();
  for (const c of campaigns ?? []) {
    const e = byChannel.get(c.channel) ?? { count: 0, budget: 0 };
    e.count++; e.budget += c.budget_cents ?? 0;
    byChannel.set(c.channel, e);
  }

  const sent = (emails ?? []).filter((e) => e.status === 'sent');
  const recip = sent.reduce((s, e) => s + (e.recipients ?? 0), 0);
  const opens = sent.reduce((s, e) => s + (e.opens ?? 0), 0);
  const clicks = sent.reduce((s, e) => s + (e.clicks ?? 0), 0);

  // Revenue influenced by lifecycle (est. monthly).
  const revByLifecycle = [
    { label: 'New', cents: customers.filter((c) => c.lifecycle === 'new').reduce((s, c) => s + planMonthlyCents(c.plan), 0) },
    { label: 'Active', cents: customers.filter((c) => c.lifecycle === 'active').reduce((s, c) => s + planMonthlyCents(c.plan), 0) },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">All figures are computed from live data. Estimated revenue is labeled as such.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><p className="text-xs text-muted">Customers</p><p className="text-2xl font-bold">{m.total}</p></Card>
        <Card><p className="text-xs text-muted">Paying</p><p className="text-2xl font-bold">{m.paying}</p></Card>
        <Card><p className="text-xs text-muted">Est. MRR</p><p className="text-2xl font-bold">{fmtMoney(m.estMrrCents)}</p></Card>
        <Card><p className="text-xs text-muted">Email open rate</p><p className="text-2xl font-bold">{recip > 0 ? `${Math.round((opens / recip) * 100)}%` : '—'}</p></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-base font-semibold">Customer Acquisition</h2>
          <Bars data={acq} max={maxAcq} />
          <p className="mt-2 text-xs text-muted">New families · last 6 months</p>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Campaigns by Channel</h2>
          {byChannel.size === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No campaigns yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {[...byChannel.entries()].map(([ch, e]) => (
                <li key={ch} className="flex items-center justify-between">
                  <span className="capitalize">{ch}</span>
                  <span className="text-muted">{e.count} campaign{e.count === 1 ? '' : 's'}{e.budget > 0 ? ` · ${fmtMoney(e.budget)}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Email Performance</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><p className="text-2xl font-bold">{recip}</p><p className="text-xs text-muted">Recipients</p></div>
            <div><p className="text-2xl font-bold">{opens}</p><p className="text-xs text-muted">Opens</p></div>
            <div><p className="text-2xl font-bold">{clicks}</p><p className="text-xs text-muted">Clicks</p></div>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Est. Revenue Influenced (monthly)</h2>
          <ul className="space-y-2 text-sm">
            {revByLifecycle.map((r) => (
              <li key={r.label} className="flex items-center justify-between">
                <span>{r.label} customers</span>
                <span className="font-semibold">{fmtMoney(r.cents)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function MarketingAnalyticsReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Analytics</h1>
        <p className="mt-1 text-sm text-muted">Live customer, campaign, and email performance metrics.</p>
      </div>
      <ErrorState message="Could not load marketing analytics from Supabase. Refresh and try again." />
      <a href="/admin/marketing/analytics" className="text-sm font-medium text-brand-text underline">Refresh analytics</a>
    </div>
  );
}
