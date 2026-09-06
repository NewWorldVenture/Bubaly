'use client';

import { useMemo, useState } from 'react';
import { PiggyBank, Plus, Trash2 } from 'lucide-react';
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
import { usd, budgetSpent, pct, type Period } from '@/lib/finance/hub';
import { useTranslations } from '@/components/i18n/locale-provider';

type Budget = Tables<'budgets'>;
type Txn = Tables<'transactions'>;
const CATEGORIES = ['Groceries', 'Dining', 'Transport', 'Entertainment', 'Shopping', 'Utilities', 'Health', 'Kids', 'Other'];

export function BudgetsView() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: budgets, loading } = useRealtimeQuery<Budget>({
    table: 'budgets', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('budgets').select('*').eq('family_id', familyId).order('category'),
  });
  const { data: txns } = useRealtimeQuery<Txn>({
    table: 'transactions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('transactions').select('*').eq('family_id', familyId).gte('date', new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10)),
  });

  const [form, setForm] = useState(false);
  const rows = budgets ?? [];
  const allTxns = useMemo(() => (txns ?? []) as unknown as { type: string; category: string | null; amount: number; date: string }[], [txns]);

  async function remove(id: string) {
    if (!confirm('Delete this budget?')) return;
    const { error } = await createClient().from('budgets').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  return (
    <div className="module-page">
      <PageHeader title={t('budgets.budgetPlanner')} description="Set category budgets and track spending against them."
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('budgets.addBudget')}</Button>} />

      {loading ? <SkeletonList /> : rows.length === 0 ? (
        <EmptyState icon={PiggyBank} title={t('budgets.noBudgetsYet')} description="Create a budget for a spending category to track it."
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('budgets.addBudget')}</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((b) => {
            const spent = budgetSpent(allTxns, b.category, b.period as Period);
            const p = pct(spent, Number(b.amount));
            const over = spent > Number(b.amount);
            return (
              <div key={b.id} className="group rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-2 flex items-start justify-between">
                  <div>
                    <p className="font-semibold">{b.category}</p>
                    <p className="text-xs capitalize text-muted">{b.period}</p>
                  </div>
                  <button onClick={() => remove(b.id)} className="rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className={cn('font-bold tabular-nums', over ? 'text-rose-400' : 'text-fg')}>{usd(spent)}</span>
                  <span className="text-xs text-muted">of {usd(Number(b.amount))}</span>
                </div>
                <div className="h-2 rounded-full bg-border">
                  <div className={cn('h-2 rounded-full transition-all', over ? 'bg-rose-500' : 'bg-emerald-500')} style={{ width: `${p}%` }} />
                </div>
                <p className={cn('mt-1 text-[11px]', over ? 'text-rose-400' : 'text-muted')}>{over ? `${usd(spent - Number(b.amount))} over budget` : `${usd(Number(b.amount) - spent)} left`}</p>
              </div>
            );
          })}
        </div>
      )}

      {form && <BudgetModal familyId={familyId} userId={userId} existing={rows.map((r) => r.category)} onClose={() => setForm(false)} />}
    </div>
  );
}

function BudgetModal({ familyId, userId, existing, onClose }: { familyId: string; userId: string; existing: string[]; onClose: () => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const avail = CATEGORIES.filter((c) => !existing.includes(c));
  const [v, setV] = useState({ category: avail[0] ?? 'Other', amount: '', period: 'monthly' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.amount) return toastError('Add an amount');
    setSaving(true);
    const { error } = await createClient().from('budgets').insert({
      family_id: familyId, category: v.category, amount: Math.abs(parseFloat(v.amount) || 0), period: v.period as Period, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Budget added');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('budgets.addBudget')}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('budgets.category')}>{(id) => <Select id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{(avail.length ? avail : CATEGORIES).map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
          <Field label={t('budgets.period')}>{(id) => <Select id={id} value={v.period} onChange={(e) => setV({ ...v, period: e.target.value })}>{['weekly', 'monthly', 'yearly'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select>}</Field>
        </div>
        <Field label={t('budgets.amount')}>{(id) => <Input id={id} type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} placeholder="500" required autoFocus />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('budgets.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.amount}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}
