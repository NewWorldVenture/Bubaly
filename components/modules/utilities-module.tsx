'use client';

import { useMemo, useState } from 'react';
import { Gauge, Plus, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { UTILITY_KINDS, utilityLabel, usd, latestByKind, monthlyTotalCents, trendForKind, deltaPct, type BillLike } from '@/lib/home/utilities';
import type { Tables } from '@/lib/database.types';

type Bill = Tables<'utility_bills'>;
const blank = () => ({ kind: 'electric', provider: '', period_month: new Date().toISOString().slice(0, 7) + '-01', amount: '', usage: '', unit: '', note: '' });

export function UtilitiesModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: bills, loading } = useRealtimeQuery<Bill>({
    table: 'utility_bills', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('utility_bills').select('*').eq('family_id', familyId).order('period_month', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const all = useMemo(() => bills ?? [], [bills]);
  const total = useMemo(() => monthlyTotalCents(all as BillLike[]), [all]);
  const latest = useMemo(() => latestByKind(all), [all]);
  const kinds = useMemo(() => [...new Set(all.map((b) => b.kind))], [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const cents = Math.round(parseFloat(form.amount || '0') * 100);
    const row = {
      kind: form.kind, provider: form.provider.trim() || null, period_month: form.period_month,
      amount_cents: cents, usage: form.usage ? parseFloat(form.usage) : null, unit: form.unit.trim() || null, note: form.note.trim() || null,
    };
    const { error } = await createClient().from('utility_bills').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(error.message);
    success('Bill added'); setForm(null);
  }
  async function remove(id: string) {
    if (!confirm('Delete this bill?')) return;
    const { error } = await createClient().from('utility_bills').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Gauge className="h-4 w-4 text-brand" /> Utility Tracking</h3>
        <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add bill</Button>
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-xs text-muted">Current monthly run-rate (latest bill per utility)</p>
        <p className="text-2xl font-bold">{usd(total)}<span className="text-sm font-normal text-muted">/mo</span></p>
      </div>

      {kinds.length === 0 ? (
        <EmptyState icon={Gauge} title="No utility bills yet" description="Log bills to monitor costs and spot increases over time." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kinds.map((kind) => {
            const cur = latest.get(kind);
            const delta = deltaPct(all as BillLike[], kind);
            const series = trendForKind(all as BillLike[], kind);
            const max = Math.max(1, ...series.map((s) => s.amount_cents));
            return (
              <div key={kind} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{utilityLabel(kind)}</p>
                  {delta !== null && (
                    <span className={`inline-flex items-center gap-1 text-xs ${delta > 0 ? 'text-danger' : 'text-success'}`}>
                      {delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{Math.abs(delta)}%
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xl font-bold">{cur ? usd(cur.amount_cents) : '—'}</p>
                <p className="text-xs text-muted">{cur ? fmtDate(cur.period_month) : ''}{cur?.provider ? ` · ${cur.provider}` : ''}</p>
                <div className="mt-3 flex h-8 items-end gap-1">
                  {series.slice(-8).map((s) => (
                    <div key={s.period_month} className="flex-1 rounded-sm bg-brand/60" style={{ height: `${(s.amount_cents / max) * 100}%` }} title={`${s.period_month}: ${usd(s.amount_cents)}`} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {all.slice(0, 30).map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3 text-sm">
            <span>{utilityLabel(b.kind)} · <span className="font-medium">{usd(b.amount_cents)}</span> · {fmtDate(b.period_month)}{b.usage ? ` · ${b.usage}${b.unit ?? ''}` : ''}</span>
            <button onClick={() => remove(b.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title="Add utility bill">
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Utility">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{UTILITY_KINDS.map((k) => <option key={k} value={k}>{utilityLabel(k)}</option>)}</Select>}</Field>
              <Field label="Month">{(id) => <Input id={id} type="date" value={form.period_month} onChange={(e) => setForm({ ...form, period_month: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ($)">{(id) => <Input id={id} type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
              <Field label="Provider">{(id) => <Input id={id} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Usage (optional)">{(id) => <Input id={id} type="number" step="0.01" value={form.usage} onChange={(e) => setForm({ ...form, usage: e.target.value })} />}</Field>
              <Field label="Unit (kWh, gal…)">{(id) => <Input id={id} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />}</Field>
            </div>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">Add</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
