import type { Metadata } from 'next';
import { Flame, Target, Inbox, ThermometerSun } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { fmtDate } from '@/lib/utils/format';
import { getMarketingCustomers } from '@/lib/marketing/customers';
import { scoreLead, summarizeLeads, LEAD_BAND_LABEL, type LeadBand } from '@/lib/marketing/lead-score';

export const metadata: Metadata = { title: 'Lead Scoring', robots: { index: false } };
export const dynamic = 'force-dynamic';

const BAND_STYLE: Record<LeadBand, string> = {
  hot: 'text-rose-300 bg-rose-500/15',
  warm: 'text-amber-300 bg-amber-500/15',
  cold: 'text-slate-300 bg-slate-500/15',
};

export default async function LeadScoringPage() {
  const supabase = createServiceClient();

  const [{ data: tickets }, customers] = await Promise.all([
    supabase.from('support_tickets').select('id, subject, description, requester_name, requester_email, status, created_at, family_id')
      .contains('tags', ['contact-form']).order('created_at', { ascending: false }).limit(100),
    getMarketingCustomers(supabase),
  ]);

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
      <p className="text-sm text-muted">Inbound leads from the contact form, scored by recency, engagement, and status — hottest first.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Leads to follow up</h2>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No inbound leads yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="pb-2">Lead</th><th className="pb-2">Status</th><th className="pb-2">Age</th><th className="pb-2">Signals</th><th className="pb-2 text-right">Score</th></tr>
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
