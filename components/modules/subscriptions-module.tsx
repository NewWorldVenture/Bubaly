'use client';

import { useMemo, useState } from 'react';
import { RefreshCw, Plus, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { SavingsCoachCard } from '@/components/modules/savings-coach-card';
import { usd } from '@/lib/finance/splits';
import {
  CADENCES, SUB_STATUSES, monthlyCostCents, annualCostCents, summarizeSubscriptions, isStale, wastedMonthlyCents,
  type SubLike,
} from '@/lib/finance/subscriptions';
import type { Tables } from '@/lib/database.types';

type Sub = Tables<'subscriptions_tracked'>;

const CATEGORIES = ['Streaming', 'Music', 'Software', 'Gaming', 'News', 'Fitness', 'Cloud', 'Membership', 'Other'];
const blank = () => ({ id: '', name: '', cost: '', cadence: 'monthly', category: 'Streaming', status: 'active', next_charge: '', last_used: '', note: '' });

export function SubscriptionsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: subs, loading } = useRealtimeQuery<Sub>({
    table: 'subscriptions_tracked', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('subscriptions_tracked').select('*').eq('family_id', familyId).order('status').order('name'),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const all = subs ?? [];
  const stats = useMemo(() => summarizeSubscriptions(all as SubLike[]), [all]);
  const wasted = useMemo(() => wastedMonthlyCents(all as SubLike[]), [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.name.trim()) return;
    const row = {
      name: form.name.trim(),
      cost_cents: Math.round(parseFloat(form.cost || '0') * 100),
      cadence: form.cadence,
      category: form.category,
      status: form.status,
      next_charge: form.next_charge || null,
      last_used: form.last_used || null,
      note: form.note.trim() || null,
    };
    const supabase = createClient();
    const { error } = form.id
      ? await supabase.from('subscriptions_tracked').update(row).eq('id', form.id)
      : await supabase.from('subscriptions_tracked').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(error.message);
    success(form.id ? 'Updated' : 'Added');
    setForm(null);
  }

  async function markUsed(id: string) {
    const { error } = await createClient().from('subscriptions_tracked').update({ last_used: new Date().toISOString().slice(0, 10) }).eq('id', id);
    if (error) toastError(error.message); else success('Marked used today');
  }
  async function setStatus(id: string, status: string) {
    const { error } = await createClient().from('subscriptions_tracked').update({ status }).eq('id', id);
    if (error) toastError(error.message);
  }
  async function remove(id: string) {
    if (!confirm('Delete this subscription?')) return;
    const { error } = await createClient().from('subscriptions_tracked').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }
  function edit(s: Sub) {
    setForm({ id: s.id, name: s.name, cost: (s.cost_cents / 100).toString(), cadence: s.cadence, category: s.category ?? 'Other', status: s.status, next_charge: s.next_charge ?? '', last_used: s.last_used ?? '', note: s.note ?? '' });
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><RefreshCw className="h-4 w-4 text-brand" /> Subscription Tracking</h3>
        <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add subscription</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Active</p><p className="text-xl font-bold">{stats.active}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Monthly</p><p className="text-xl font-bold">{usd(stats.monthlyCents)}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Annual</p><p className="text-xl font-bold">{usd(stats.annualCents)}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Wasted / mo</p><p className={`text-xl font-bold ${wasted > 0 ? 'text-amber-500' : ''}`}>{usd(wasted)}</p></div>
      </div>

      <SavingsCoachCard />

      {wasted > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p>You could save <strong>{usd(wasted)}/mo</strong> ({usd(wasted * 12)}/yr) by reviewing subscriptions unused for 60+ days (flagged below).</p>
        </div>
      )}

      <div className="space-y-2">
        {all.length === 0 ? (
          <EmptyState icon={RefreshCw} title="No subscriptions tracked" description="Add streaming, apps and memberships to see your true recurring spend." />
        ) : all.map((s) => {
          const stale = isStale(s as SubLike);
          const canceled = s.status === 'canceled';
          return (
            <div key={s.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3">
              <div className="min-w-0">
                <p className={`font-medium ${canceled ? 'text-muted line-through' : ''}`}>
                  {s.name} <span className="text-muted">· {usd(s.cost_cents)}/{s.cadence === 'monthly' ? 'mo' : s.cadence === 'yearly' ? 'yr' : s.cadence}</span>
                  {stale && !canceled && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-500"><AlertTriangle className="h-3 w-3" /> unused</span>}
                  {s.status === 'trial' && <span className="ml-2 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-400">trial</span>}
                </p>
                <p className="text-xs text-muted">
                  {s.category ?? 'Other'} · {usd(monthlyCostCents(s.cost_cents, s.cadence))}/mo · {usd(annualCostCents(s.cost_cents, s.cadence))}/yr
                  {s.next_charge ? ` · next ${fmtDate(s.next_charge)}` : ''}{s.last_used ? ` · used ${fmtDate(s.last_used)}` : ' · never used'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                {!canceled && <button onClick={() => markUsed(s.id)} className="inline-flex items-center gap-1 text-muted hover:text-success" title="Mark used today"><CheckCircle2 className="h-4 w-4" /></button>}
                <button onClick={() => setStatus(s.id, canceled ? 'active' : 'canceled')} className="text-muted hover:text-fg hover:underline">{canceled ? 'Reactivate' : 'Cancel'}</button>
                <button onClick={() => edit(s)} className="text-muted hover:text-fg hover:underline">Edit</button>
                <button onClick={() => remove(s.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          );
        })}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit subscription' : 'Add subscription'}>
          <form onSubmit={save} className="space-y-3">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Netflix, Spotify…" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cost ($)">{(id) => <Input id={id} type="number" step="0.01" min="0" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />}</Field>
              <Field label="Billing">{(id) => <Select id={id} value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>{CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
              <Field label="Status">{(id) => <Select id={id} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{SUB_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Next charge">{(id) => <Input id={id} type="date" value={form.next_charge} onChange={(e) => setForm({ ...form, next_charge: e.target.value })} />}</Field>
              <Field label="Last used">{(id) => <Input id={id} type="date" value={form.last_used} onChange={(e) => setForm({ ...form, last_used: e.target.value })} />}</Field>
            </div>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
