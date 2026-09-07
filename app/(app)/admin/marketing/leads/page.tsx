import type { Metadata } from 'next';
import Link from 'next/link';
import { Flame, Target, Inbox, ThermometerSun } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { getMarketingCustomersWithError } from '@/lib/marketing/customers';
import { scoreLead, summarizeLeads, LEAD_BAND_LABEL, type LeadBand } from '@/lib/marketing/lead-score';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'leads.leadScoring', robots: { index: false } };
export const dynamic = 'force-dynamic';

const BAND_STYLE: Record<LeadBand, string> = {
  hot: 'text-rose-300 bg-rose-500/15',
  warm: 'text-amber-300 bg-amber-500/15',
  cold: 'text-slate-300 bg-slate-500/15',
};

export default async function LeadScoringPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();

  const [ticketsResult, customersResult] = await Promise.all([
    supabase.from('support_tickets').select('id, subject, description, requester_name, requester_email, status, created_at, family_id')
      .contains('tags', ['contact-form']).order('created_at', { ascending: false }).limit(100),
    getMarketingCustomersWithError(supabase),
  ]);
  const readError = ticketsResult.error ?? customersResult.error;
  if (readError) {
    console.error('[admin-marketing-leads] lead read failed', readError);
    return <AdminLeadsReadError />;
  }
  const { data: tickets } = ticketsResult;
  const { customers } = customersResult;

  const customerEmails = new Set(customers.map((c) => c.ownerEmail?.toLowerCase()).filter(Boolean) as string[]);

  const rows = (tickets ?? []).map((t) => {
    const isCustomer = Boolean(t.family_id) || customerEmails.has((t.requester_email ?? '').toLowerCase());
    const s = scoreLead({ createdAt: t.created_at, status: t.status, message: t.description, name: t.requester_name, isCustomer });
    return { t, s, isCustomer };
  }).sort((a, b) => b.s.score - a.s.score);

  const summary = summarizeLeads(rows.map((r) => ({ band: r.s.band, status: r.t.status })));

  const stats = [
    { label: 'Total Leads', value: summary.total, icon: Inbox, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Hot', value: summary.hot, icon: Flame, tint: 'text-rose-400 bg-rose-500/15' },
    { label: 'Warm', value: summary.warm, icon: ThermometerSun, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Open', value: summary.open, icon: Target, tint: 'text-emerald-400 bg-emerald-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{tr('adminMarketingLeads.inboundLeadsFromTheContactForm')}</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{tr('adminMarketingLeads.leadsToFollowUp')}</h2>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{tr('adminMarketingLeads.noInboundLeadsYet')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="pb-2">{tr('adminMarketingLeads.lead')}</th><th className="pb-2">{tr('adminMarketingLeads.status')}</th><th className="pb-2">Age</th><th className="pb-2">{tr('adminMarketingLeads.signals')}</th><th className="pb-2 text-right">{tr('adminMarketingLeads.score')}</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map(({ t, s, isCustomer }) => (
                  <tr key={t.id} className="border-t border-border align-top">
                    <td className="py-2">
                      <p className="font-medium">{t.requester_name || t.requester_email}</p>
                      <p className="text-xs text-muted">{t.requester_email}{isCustomer && <span className="ml-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300">customer</span>}</p>
                      {t.subject && <p className="mt-0.5 truncate text-xs text-muted">{t.subject}</p>}
                    </td>
                    <td className="py-2 capitalize">{t.status}</td>
                    <td className="py-2">{s.ageDays >= 999 ? '—' : `${s.ageDays}d`}</td>
                    <td className="py-2"><span className="text-xs text-muted">{s.reasons.slice(0, 2).join(' · ') || '—'}</span></td>
                    <td className="py-2 text-right">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${BAND_STYLE[s.band]}`}>{s.score} · {LEAD_BAND_LABEL[s.band]}</span>
                      <p className="mt-1 text-[11px] text-muted">{fmtDate(t.created_at)}</p>
                    </td>
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

async function AdminLeadsReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('leads.leadScoring')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('leads.prioritizeInboundLeadsUsingLive')}</p>
      </div>
      <ErrorState message={tr('leads.couldNotLoadLeadScoring')} />
      <Link href="/admin/marketing/leads" className="text-sm font-medium text-brand-text underline">{tr('leads.refreshLeads')}</Link>
    </div>
  );
}
