import type { Metadata } from 'next';
import Link from 'next/link';
import { Users } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { getMarketingCustomersWithError, type Lifecycle } from '@/lib/marketing/customers';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Customers', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TONE: Record<Lifecycle, 'success' | 'brand' | 'warning' | 'danger' | 'neutral'> = {
  new: 'success', active: 'brand', lapsed: 'warning', churned: 'danger', free: 'neutral',
};
const FILTERS: (Lifecycle | 'all')[] = ['all', 'new', 'active', 'lapsed', 'churned', 'free'];

export default async function MarketingCustomersPage({ searchParams }: { searchParams: Promise<{ lifecycle?: string; q?: string }> }) {
  const t = await getTranslations();
  const { lifecycle = 'all', q = '' } = await searchParams;
  const supabase = createServiceClient();
  const { customers: loadedCustomers, error: customersError } = await getMarketingCustomersWithError(supabase);
  if (customersError) {
    console.error('[admin-marketing-customers] customer read failed', customersError);
    return <AdminCustomersReadError />;
  }
  let customers = loadedCustomers;

  if (lifecycle !== 'all') customers = customers.filter((c) => c.lifecycle === lifecycle);
  if (q.trim()) {
    const needle = q.trim().toLowerCase();
    customers = customers.filter((c) => c.name.toLowerCase().includes(needle) || (c.ownerEmail ?? '').toLowerCase().includes(needle));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{customers.length.toLocaleString()} customer{customers.length === 1 ? '' : 's'} {t('adminMarketingCustomers.derivedLiveFromFamiliesAmpSubscriptions')}</p>
        <form className="flex gap-2" action="/admin/marketing/customers" method="GET">
          {lifecycle !== 'all' && <input type="hidden" name="lifecycle" value={lifecycle} />}
          <input name="q" defaultValue={q} placeholder={t('adminMarketingCustomers.searchNameOrEmail')} className="h-9 rounded-lg border border-border bg-surface/60 px-3 text-sm focus-ring" />
        </form>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <a
            key={f}
            href={`/admin/marketing/customers${f === 'all' ? '' : `?lifecycle=${f}`}`}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition ${f === lifecycle ? 'border-brand/40 bg-brand/15 text-brand-text' : 'border-border text-muted hover:bg-elevated'}`}
          >
            {f}
          </a>
        ))}
      </div>

      {customers.length === 0 ? (
        <EmptyState icon={Users} title={t('adminMarketingCustomers.noCustomersMatch')} description={t('customers.adjustTheFilterOrSearch')} />
      ) : (
        <Card className="p-0">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.family')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.owner')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.members')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.plan')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.lifecycle')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.estLtv')}</th>
                  <th className="px-4 py-3 font-medium">{t('adminMarketingCustomers.joined')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {customers.slice(0, 500).map((c) => (
                  <tr key={c.familyId} className="hover:bg-surface/30">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-muted">{c.ownerEmail ?? '—'}</td>
                    <td className="px-4 py-3 text-muted">{c.memberCount}</td>
                    <td className="px-4 py-3 text-muted">{c.planLabel}</td>
                    <td className="px-4 py-3"><Badge tone={TONE[c.lifecycle]} className="capitalize">{c.lifecycle}</Badge></td>
                    <td className="px-4 py-3 font-medium">{fmtMoney(c.estLtvCents)}</td>
                    <td className="px-4 py-3 text-muted">{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border/60 md:hidden">
            {customers.slice(0, 200).map((c) => (
              <li key={c.familyId} className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted">{c.ownerEmail ?? '—'}</p>
                  <p className="mt-1 text-xs text-muted">{c.planLabel} · {c.memberCount} members · {fmtMoney(c.estLtvCents)}</p>
                </div>
                <Badge tone={TONE[c.lifecycle]} className="shrink-0 capitalize">{c.lifecycle}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

async function AdminCustomersReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('customers.marketingCustomers')}</h1>
        <p className="mt-1 text-sm text-muted">{t('customers.reviewCustomersDerivedFromFamilies')}</p>
      </div>
      <ErrorState message={t('customers.couldNotLoadMarketingCustomers')} />
      <Link href="/admin/marketing/customers" className="text-sm font-medium text-brand-text underline">{t('customers.refreshCustomers')}</Link>
    </div>
  );
}
