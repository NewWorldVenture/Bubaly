import type { Metadata } from 'next';
import Link from 'next/link';
import { HeartPulse, ShieldAlert, Activity, Gauge, ArrowRight } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { getMarketingCustomersWithError } from '@/lib/marketing/customers';
import { customerHealth, summarizeHealth, HEALTH_BAND_LABEL, type Health } from '@/lib/marketing/health';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Customer Health', robots: { index: false } };
export const dynamic = 'force-dynamic';

const BAND_STYLE = {
  healthy: 'text-emerald-300 bg-emerald-500/15',
  monitor: 'text-amber-300 bg-amber-500/15',
  at_risk: 'text-rose-300 bg-rose-500/15',
} as const;

export default async function CustomerHealthPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // Fail closed: a transient read failure must NOT render as "no customers" — that
  // would hide every at-risk/churning family from the super-admin during an outage.
  const { customers, error: customersError } = await getMarketingCustomersWithError(supabase);
  if (customersError) {
    console.error('[admin-marketing-health] customer read failed', customersError);
    return <CustomerHealthReadError />;
  }

  const rows = customers
    .map((c) => ({ c, h: customerHealth({ lifecycle: c.lifecycle, memberCount: c.memberCount, lastActivityAt: c.lastActivityAt }) }))
    .sort((a, b) => a.h.score - b.h.score); // worst first — these need attention
  const summary = summarizeHealth(rows.map((r) => r.h));

  const stats = [
    { label: 'Avg Health', value: summary.avgScore == null ? '—' : `${summary.avgScore}`, icon: Gauge, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Healthy', value: summary.healthy, icon: Activity, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Monitor', value: summary.monitor, icon: HeartPulse, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Churn Risk', value: summary.churnRisk, icon: ShieldAlert, tint: 'text-rose-400 bg-rose-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('adminMarketingHealth.perCustomerHealthAmpChurnRisk')}</p>

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

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('adminMarketingHealth.customersNeedingAttention')}</h2>
          <Link href="/admin/marketing/campaigns/new" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline">
            {t('adminMarketingHealth.launchWinBack')} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('adminMarketingHealth.noCustomersYet')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="pb-2">{t('adminMarketingHealth.family')}</th><th className="pb-2">{t('adminMarketingHealth.plan')}</th><th className="pb-2">{t('adminMarketingHealth.lifecycle')}</th><th className="pb-2">{t('adminMarketingHealth.inactive')}</th><th className="pb-2">{t('adminMarketingHealth.health')}</th><th className="pb-2 text-right">{t('adminMarketingHealth.risk')}</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map(({ c, h }: { c: typeof rows[number]['c']; h: Health }) => (
                  <tr key={c.familyId} className="border-t border-border">
                    <td className="py-2"><p className="font-medium">{c.name}</p>{c.ownerEmail && <p className="text-xs text-muted">{c.ownerEmail}</p>}</td>
                    <td className="py-2">{c.planLabel}</td>
                    <td className="py-2 capitalize">{c.lifecycle}</td>
                    <td className="py-2">{h.inactiveDays >= 999 ? '—' : `${h.inactiveDays}d`}</td>
                    <td className="py-2">
                      <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-0.5 text-xs font-medium ${BAND_STYLE[h.band]}`}>
                        {h.score} · {HEALTH_BAND_LABEL[h.band]}
                      </span>
                    </td>
                    <td className="py-2 text-right">{h.churnRisk ? <span className="text-rose-300">●</span> : <span className="text-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

async function CustomerHealthReadError() {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('health.customerHealth')}</h1>
        <p className="mt-1 text-sm text-muted">Per-customer health &amp; churn risk.</p>
      </div>
      <ErrorState message={t('health.couldNotLoadCustomerHealth')} />
      <Link href="/admin/marketing/health" className="text-sm font-medium text-brand-text underline">{t('health.refreshCustomerHealth')}</Link>
    </div>
  );
}
