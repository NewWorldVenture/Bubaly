'use client';

import { useMemo, useState } from 'react';
import { FileText, Plus, Trash2, Check, RotateCcw, Repeat, Bell } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { usd, billDueStatus, DUE_META, fmtDueDate } from '@/lib/finance/hub';
import { useTranslations } from '@/components/i18n/locale-provider';

type Bill = Tables<'bills'>;
export type BillsMode = 'all' | 'autopay' | 'due';

const CATEGORIES = ['Housing', 'Utilities', 'Insurance', 'Subscriptions', 'Loans', 'Phone', 'Internet', 'Other'];

const MODE_META: Record<BillsMode, { title: string; desc: string; icon: typeof FileText }> = {
  all: { title: 'Bill Manager', desc: 'Track every bill, mark them paid, and never miss a due date.', icon: FileText },
  autopay: { title: 'Auto Pay', desc: 'Bills set to pay automatically each cycle.', icon: Repeat },
  due: { title: 'Due Reminders', desc: 'Upcoming and overdue bills that need your attention.', icon: Bell },
};

export function BillsView({ mode }: { mode: BillsMode }) {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const meta = MODE_META[mode];

  const { data: rows, loading } = useRealtimeQuery<Bill>({
    table: 'bills', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('bills').select('*').eq('family_id', familyId).order('due_date', { ascending: true }),
  });

  const [form, setForm] = useState(false);
  const bills = useMemo(() => rows ?? [], [rows]);

  const visible = useMemo(() => {
    if (mode === 'autopay') return bills.filter((b) => b.autopay);
    if (mode === 'due') return bills.filter((b) => b.status !== 'paid');
    return bills;
  }, [bills, mode]);

  const totalDue = useMemo(() => visible.filter((b) => b.status !== 'paid').reduce((s, b) => s + Number(b.amount), 0), [visible]);

  async function markPaid(b: Bill) {
    const next = b.status === 'paid' ? 'upcoming' : 'paid';
    const { error } = await createClient().from('bills').update({ status: next }).eq('id', b.id);
    if (error) toastError(error.message); else success(next === 'paid' ? 'Marked paid' : 'Reopened');
  }
  async function toggleAutopay(b: Bill) {
    const { error } = await createClient().from('bills').update({ autopay: !b.autopay }).eq('id', b.id);
    if (error) toastError(error.message); else success(b.autopay ? 'Auto Pay off' : 'Auto Pay on');
  }
  async function remove(id: string) {
    if (!confirm('Delete this bill?')) return;
    const { error } = await createClient().from('bills').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  const Row = ({ b }: { b: Bill }) => {
  const t = useTranslations();
    const ds = billDueStatus(b);
    const dm = DUE_META[ds];
    return (
      <div className="group flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', dm.tint)}><FileText className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{b.name}</p>
          <p className="truncate text-xs text-muted">
            Due {fmtDueDate(b.due_date)}{b.category ? ` · ${b.category}` : ''}{b.is_recurring ? ' · recurring' : ''}
            {b.autopay && <span className="ml-1 inline-flex items-center gap-0.5 text-brand-text"><Repeat className="h-3 w-3" /> {t('bills.autoPay')}</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold tabular-nums">{usd(Number(b.amount))}</p>
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', dm.tint)}>{dm.label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {mode !== 'due' && (
            <button onClick={() => toggleAutopay(b)} title={t('bills.toggleAutoPay')}
              className={cn('rounded-lg p-1.5 transition', b.autopay ? 'text-brand-text' : 'text-muted/50 hover:text-fg')}><Repeat className="h-4 w-4" /></button>
          )}
          <button onClick={() => markPaid(b)} title={b.status === 'paid' ? 'Reopen' : 'Mark paid'}
            className="rounded-lg p-1.5 text-muted/50 transition hover:text-emerald-400">{b.status === 'paid' ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}</button>
          <button onClick={() => remove(b.id)} className="rounded-lg p-1.5 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={t('bills.delete')}><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
    );
  };

  // For Due Reminders, group by urgency.
  const grouped = useMemo(() => {
    if (mode !== 'due') return null;
    const g: Record<string, Bill[]> = { overdue: [], due_soon: [], upcoming: [] };
    for (const b of visible) { const s = billDueStatus(b); if (s !== 'paid') g[s].push(b); }
    return g;
  }, [visible, mode]);

  return (
    <div className="module-page">
      <PageHeader title={meta.title} description={meta.desc}
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('bills.addBill')}</Button>} />

      {mode !== 'autopay' && visible.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <p className="text-xs text-muted">{mode === 'due' ? 'Outstanding' : 'Total unpaid'}</p>
          <p className="text-2xl font-black tabular-nums">{usd(totalDue)}</p>
        </div>
      )}

      {loading ? <SkeletonList /> : visible.length === 0 ? (
        <EmptyState icon={meta.icon} title={mode === 'autopay' ? 'No Auto Pay bills' : mode === 'due' ? 'Nothing due' : 'No bills yet'}
          description={mode === 'autopay' ? 'Turn on Auto Pay for a bill to see it here.' : 'Add a bill to start tracking due dates.'}
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('bills.addBill')}</Button>} />
      ) : grouped ? (
        <div className="space-y-5">
          {(['overdue', 'due_soon', 'upcoming'] as const).map((k) => grouped[k].length > 0 && (
            <section key={k}>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{DUE_META[k].label}</h2>
              <div className="space-y-2">{grouped[k].map((b) => <Row key={b.id} b={b} />)}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-2">{visible.map((b) => <Row key={b.id} b={b} />)}</div>
      )}

      {form && <BillModal familyId={familyId} userId={userId} defaultAutopay={mode === 'autopay'} onClose={() => setForm(false)} />}
    </div>
  );
}

function BillModal({ familyId, userId, defaultAutopay, onClose }: { familyId: string; userId: string; defaultAutopay: boolean; onClose: () => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ name: '', amount: '', due_date: new Date().toISOString().slice(0, 10), category: 'Utilities', is_recurring: true, autopay: defaultAutopay });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.name.trim() || !v.amount) return toastError('Add a name and amount');
    setSaving(true);
    const { error } = await createClient().from('bills').insert({
      family_id: familyId, name: v.name.trim(), amount: Math.abs(parseFloat(v.amount) || 0),
      due_date: v.due_date, category: v.category, is_recurring: v.is_recurring, autopay: v.autopay,
      status: 'upcoming', created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Bill added');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('bills.addBill')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('bills.billName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('billsView.electricBill')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('bills.amount')}>{(id) => <Input id={id} type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} placeholder="120.00" required />}</Field>
          <Field label={t('bills.dueDate')}>{(id) => <Input id={id} type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} />}</Field>
        </div>
        <Field label={t('bills.category')}>{(id) => <Select id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_recurring} onChange={(e) => setV({ ...v, is_recurring: e.target.checked })} /> {t('bills.recurring')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.autopay} onChange={(e) => setV({ ...v, autopay: e.target.checked })} /> {t('bills.autoPay')}</label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('bills.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.name.trim() || !v.amount}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}
