'use client';

import { useMemo, useState } from 'react';
import { Split, Plus, Trash2, Check, ArrowRight, Scale, Loader2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AiInsight } from '@/components/ai/ai-insight';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import {
  usd, splitEvenly, memberBalances, settlementSuggestions, summarizeSplits,
  type SplitLike, type ShareLike,
} from '@/lib/finance/splits';
import type { Tables } from '@/lib/database.types';

type SplitRow = Tables<'expense_splits'>;
type Share = Tables<'expense_split_shares'>;

const CATEGORIES = ['Groceries', 'Dining', 'Travel', 'Utilities', 'Entertainment', 'Household', 'Gifts', 'Other'];
const blank = () => ({ description: '', amount: '', category: 'Groceries', paid_by: '', spent_on: new Date().toISOString().slice(0, 10), participants: [] as string[] });

export function ExpensesModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });
  const [saving, setSaving] = useState(false);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberName = (id: string | null) => (id ? memberById.get(id)?.display_name ?? 'Member' : '—');

  const { data: splits, loading: splitsLoading, error: splitsError, refresh: refreshSplits } = useRealtimeQuery<SplitRow>({
    table: 'expense_splits', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('expense_splits').select('*').eq('family_id', familyId).order('spent_on', { ascending: false }),
  });
  const { data: shares, loading: sharesLoading, error: sharesError, refresh: refreshShares } = useRealtimeQuery<Share>({
    table: 'expense_split_shares', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('expense_split_shares').select('*').eq('family_id', familyId),
  });

  const loading = splitsLoading || sharesLoading;
  const error = splitsError || sharesError;
  const refresh = () => { void refreshSplits(); void refreshShares(); };

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);

  const allSplits = useMemo(() => splits ?? [], [splits]);
  const allShares = useMemo(() => shares ?? [], [shares]);
  const sharesBySplit = useMemo(() => {
    const m = new Map<string, Share[]>();
    for (const s of allShares) { const a = m.get(s.split_id) ?? []; a.push(s); m.set(s.split_id, a); }
    return m;
  }, [allShares]);

  const net = useMemo(
    () => memberBalances(allSplits as SplitLike[], allShares as ShareLike[]),
    [allSplits, allShares],
  );
  const transfers = useMemo(() => settlementSuggestions(net), [net]);
  const summary = useMemo(() => summarizeSplits(allSplits as SplitLike[], allShares as ShareLike[]), [allSplits, allShares]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form || !form.description.trim()) return toastError('Add a description');
    if (form.description.trim().length > 120) return toastError('Description is too long (max 120 characters)');
    const parsed = parseFloat(form.amount || '0');
    if (!Number.isFinite(parsed) || parsed <= 0) return toastError('Enter a valid amount greater than $0');
    const totalCents = Math.round(parsed * 100);
    const participants = form.participants.length ? form.participants : members.map((m) => m.id);
    if (participants.length === 0) return toastError('Add a family member first');

    setSaving(true);
    const supabase = createClient();
    try {
      const { data: split, error } = await supabase.from('expense_splits').insert({
        family_id: familyId,
        description: form.description.trim(),
        total_cents: totalCents,
        category: form.category,
        paid_by: form.paid_by || null,
        spent_on: form.spent_on,
        created_by: userId,
      }).select('id').single();
      if (error || !split) { toastError(describeDbError(error)); return; }

      const shareMap = splitEvenly(totalCents, participants);
      const rows = [...shareMap.entries()].map(([member_id, share_cents]) => ({
        family_id: familyId, split_id: split.id, member_id, share_cents,
        settled: member_id === form.paid_by, // payer's own share starts settled
      }));
      const { error: sErr } = await supabase.from('expense_split_shares').insert(rows);
      if (sErr) {
        // Roll back the orphaned split so we never leave a parent without shares.
        await supabase.from('expense_splits').delete().eq('id', split.id);
        toastError(describeDbError(sErr));
        return;
      }
      success('Expense split');
      setForm(null);
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setSaving(false);
    }
  }

  function toggleSettled(s: Share) {
    return run(`settle:${s.id}`, async () => {
      const { error } = await createClient().from('expense_split_shares')
        .update({ settled: !s.settled, settled_at: !s.settled ? new Date().toISOString() : null })
        .eq('id', s.id);
      if (error) throw error;
    });
  }

  function removeSplit(id: string) {
    if (!confirm('Delete this expense and its shares?')) return;
    return run(`remove:${id}`, async () => {
      const { error } = await createClient().from('expense_splits').delete().eq('id', id);
      if (error) throw error;
      success('Deleted');
    });
  }

  function toggleParticipant(id: string) {
    if (!form) return;
    const has = form.participants.includes(id);
    setForm({ ...form, participants: has ? form.participants.filter((x) => x !== id) : [...form.participants, id] });
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load shared expenses. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Split className="h-4 w-4 text-brand-text" /> Expense Splitting</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="expenses" />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Split an expense</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Expenses</p><p className="text-xl font-bold">{summary.count}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Total split</p><p className="text-xl font-bold">{usd(summary.totalCents)}</p></div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4"><p className="text-xs text-muted">Outstanding</p><p className="text-xl font-bold">{usd(summary.unsettledCents)}</p></div>
      </div>

      {/* Settle up */}
      {transfers.length > 0 && (
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><Scale className="h-4 w-4 text-brand-text" /> Settle up</p>
          <ul className="space-y-1 text-sm">
            {transfers.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <Avatar name={memberName(t.from)} size={22} /> <span className="font-medium">{memberName(t.from)}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted" />
                <Avatar name={memberName(t.to)} size={22} /> <span className="font-medium">{memberName(t.to)}</span>
                <span className="ml-auto font-semibold">{usd(t.cents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Splits */}
      <div className="space-y-2">
        {allSplits.length === 0 ? (
          <EmptyState icon={Split} title="No shared expenses yet" description="Split a bill or purchase across family members and track who owes whom." />
        ) : allSplits.map((sp) => {
          const sh = sharesBySplit.get(sp.id) ?? [];
          return (
            <div key={sp.id} className="rounded-xl border border-border bg-surface/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{sp.description} <span className="text-muted">· {usd(sp.total_cents)}</span></p>
                  <p className="text-xs text-muted">{sp.category ?? 'Other'} · paid by {memberName(sp.paid_by)} · {fmtDate(sp.spent_on)}</p>
                </div>
                <button onClick={() => removeSplit(sp.id)} disabled={isPending(`remove:${sp.id}`)} className="text-muted transition hover:text-danger disabled:opacity-50" aria-label="Delete">
                  {isPending(`remove:${sp.id}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {sh.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => toggleSettled(s)}
                    disabled={isPending(`settle:${s.id}`)}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition disabled:opacity-60 ${s.settled ? 'bg-success/15 text-success' : 'bg-border/40 text-muted hover:bg-border/70'}`}
                    title={s.settled ? 'Settled — click to unsettle' : 'Mark settled'}
                  >
                    {isPending(`settle:${s.id}`) ? <Loader2 className="h-3 w-3 animate-spin" /> : s.settled && <Check className="h-3 w-3" />} {memberName(s.member_id)} {usd(s.share_cents)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title="Split an expense">
          <form onSubmit={save} className="space-y-3">
            <Field label="Description">{(id) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Dinner, groceries…" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ($)">{(id) => <Input id={id} type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
              <Field label="Date">{(id) => <Input id={id} type="date" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
              <Field label="Paid by">{(id) => <Select id={id} value={form.paid_by} onChange={(e) => setForm({ ...form, paid_by: e.target.value })}><option value="">— Select —</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            </div>
            <Field label="Split between (default: everyone)">
              {() => (
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {members.map((m) => {
                    const on = form.participants.includes(m.id);
                    return (
                      <button type="button" key={m.id} onClick={() => toggleParticipant(m.id)}
                        className={`rounded-full px-2.5 py-1 text-xs ${on ? 'bg-brand text-white' : 'bg-border/40 text-muted hover:bg-border/70'}`}>
                        {m.display_name}
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Split it</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
