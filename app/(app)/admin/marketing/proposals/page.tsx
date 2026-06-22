import type { Metadata } from 'next';
import { FileText, Send, CheckCircle2, Percent } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { fmtDate } from '@/lib/utils/format';
import { contactDisplayName, formatCents } from '@/lib/marketing/crm';
import {
  summarizeQuotes, effectiveStatus, QUOTE_STATUSES, QUOTE_STATUS_LABELS, type QuoteStatus,
} from '@/lib/marketing/quotes';
import type { Tables } from '@/lib/database.types';
import { saveQuoteAction, setQuoteStatusAction, deleteQuoteAction } from './actions';

export const metadata: Metadata = { title: 'Proposals · Quotes', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Quote = Tables<'crm_quotes'>;
type Contact = Tables<'crm_contacts'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const STATUS_TINT: Record<QuoteStatus, string> = {
  draft: 'bg-slate-500/15 text-slate-300', sent: 'bg-blue-500/15 text-blue-300',
  accepted: 'bg-emerald-500/15 text-emerald-300', declined: 'bg-rose-500/15 text-rose-300',
  expired: 'bg-amber-500/15 text-amber-300',
};

export default async function ProposalsPage() {
  const supabase = createServiceClient();
  const [{ data: quotes }, { data: contacts }] = await Promise.all([
    supabase.from('crm_quotes').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('crm_contacts').select('id, first_name, last_name, email').order('created_at', { ascending: false }).limit(500),
  ]);

  const list = (quotes ?? []) as Quote[];
  const contactList = (contacts ?? []) as Pick<Contact, 'id' | 'first_name' | 'last_name' | 'email'>[];
  const contactName = new Map(contactList.map((c) => [c.id, contactDisplayName(c)]));
  const summary = summarizeQuotes(list.map((q) => ({ status: q.status as QuoteStatus, amount_cents: q.amount_cents, valid_until: q.valid_until })));

  const stats = [
    { label: 'Quotes', value: summary.total, icon: FileText, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Outstanding', value: formatCents(summary.outstandingCents), icon: Send, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Accepted', value: formatCents(summary.acceptedCents), icon: CheckCircle2, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Accept rate', value: `${Math.round(summary.acceptRate * 100)}%`, icon: Percent, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">Quotes and proposals that convert qualified leads into customers — tracked from draft to accepted.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">New quote</h2>
        <form action={saveQuoteAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder="Proposal title" className={`${inputCls} lg:col-span-2`} />
          <input name="amount" type="number" min="0" step="0.01" placeholder="Amount ($)" className={inputCls} />
          <select name="status" defaultValue="draft" className={inputCls}>
            {QUOTE_STATUSES.filter((s) => s !== 'expired').map((s) => <option key={s} value={s}>{QUOTE_STATUS_LABELS[s]}</option>)}
          </select>
          <select name="contact_id" defaultValue="" className={`${inputCls} lg:col-span-2`}>
            <option value="">No contact</option>
            {contactList.map((c) => <option key={c.id} value={c.id}>{contactDisplayName(c)}</option>)}
          </select>
          <input name="valid_until" type="date" className={inputCls} />
          <button type="submit" className={btnCls}>Create quote</button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Proposals</h2>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No proposals yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2">Title</th><th className="pb-2">Contact</th><th className="pb-2">Amount</th>
                  <th className="pb-2">Status</th><th className="pb-2">Valid until</th><th className="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((qt) => {
                  const eff = effectiveStatus({ status: qt.status as QuoteStatus, amount_cents: qt.amount_cents, valid_until: qt.valid_until });
                  return (
                    <tr key={qt.id} className="border-t border-border align-top">
                      <td className="py-2 font-medium">{qt.title}</td>
                      <td className="py-2">{qt.contact_id ? contactName.get(qt.contact_id) ?? '—' : '—'}</td>
                      <td className="py-2">{formatCents(qt.amount_cents)}</td>
                      <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_TINT[eff]}`}>{QUOTE_STATUS_LABELS[eff]}</span></td>
                      <td className="py-2 text-xs text-muted">{qt.valid_until ? fmtDate(qt.valid_until) : '—'}</td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-1">
                          {qt.status === 'draft' && (
                            <form action={setQuoteStatusAction.bind(null, qt.id, 'sent')}>
                              <button type="submit" className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-fg">Send</button>
                            </form>
                          )}
                          {(qt.status === 'sent') && (
                            <>
                              <form action={setQuoteStatusAction.bind(null, qt.id, 'accepted')}>
                                <button type="submit" className="rounded-md border border-border px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Accept</button>
                              </form>
                              <form action={setQuoteStatusAction.bind(null, qt.id, 'declined')}>
                                <button type="submit" className="rounded-md border border-border px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10">Decline</button>
                              </form>
                            </>
                          )}
                          <form action={deleteQuoteAction.bind(null, qt.id)}>
                            <button type="submit" className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:text-rose-400">✕</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
