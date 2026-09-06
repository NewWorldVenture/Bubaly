'use client';

import { useMemo, useState } from 'react';
import { Wallet, Receipt, AlertTriangle } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { TripCrudSection, StatPill, Progress, type FieldDef } from './shared';
import { BUDGET_CATEGORIES, dollars, lookup } from '@/lib/vacations/meta';
import { summarizeBudget } from '@/lib/vacations/budget';
import { fmtDate } from '@/lib/utils/format';
import type { Tables, VacBudgetCategory } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Budget = Tables<'vacation_budgets'>;
type Expense = Tables<'vacation_expenses'>;

const expenseFields: FieldDef[] = [
  { name: 'description', label: 'Description', type: 'text', required: true },
  { name: 'amount_cents', label: 'Amount ($)', type: 'money', required: true, half: true },
  { name: 'category', label: 'Category', type: 'select', required: true, half: true, options: BUDGET_CATEGORIES.map((c) => ({ value: c.value, label: c.label })) },
  { name: 'spent_on', label: 'Date', type: 'date', half: true },
  { name: 'paid_by_member_id', label: 'Paid by', type: 'member', half: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function TripBudget({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: budgets, loading: budgetsLoading, error: budgetsError, refresh: refreshBudgets } = useRealtimeQuery<Budget>({
    table: 'vacation_budgets', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_budgets').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });
  const { data: expenses, loading: expensesLoading, error: expensesError, refresh: refreshExpenses } = useRealtimeQuery<Expense>({
    table: 'vacation_expenses', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_expenses').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });

  const summary = useMemo(() => summarizeBudget(budgets, expenses), [budgets, expenses]);
  const plannedByCat = useMemo(() => new Map(budgets.map((b) => [b.category, b])), [budgets]);
  const [editing, setEditing] = useState<VacBudgetCategory | null>(null);
  const [draft, setDraft] = useState('');
  const refreshAll = () => { void Promise.all([refreshBudgets(), refreshExpenses()]); };

  async function savePlanned(cat: VacBudgetCategory) {
    const cents = draft ? Math.round(parseFloat(draft) * 100) : 0;
    const existing = plannedByCat.get(cat);
    const { error } = existing
      ? await createClient().from('vacation_budgets').update({ planned_cents: cents }).eq('id', existing.id)
      : await createClient().from('vacation_budgets').insert({ family_id: familyId, vacation_id: vacationId, category: cat, planned_cents: cents, created_by: userId });
    if (error) toastError(error.message); else success('Budget updated');
    setEditing(null);
  }

  if (budgetsLoading || expensesLoading) return <LoadingBlock />;
  if (budgetsError || expensesError) return <ErrorState message="Could not load this trip budget. Refresh and try again." onRetry={refreshAll} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatPill label={t('tripBudget.planned')} value={dollars(summary.planned_cents)} />
        <StatPill label={t('tripBudget.spent')} value={dollars(summary.spent_cents)} />
        <StatPill label={t('tripBudget.remaining')} value={dollars(summary.remaining_cents)} tone={summary.remaining_cents < 0 ? 'border-rose-500/40' : ''} />
        <StatPill label={t('tripBudget.used')} value={`${summary.pct === 999 ? '∞' : summary.pct}%`} tone={summary.over ? 'border-rose-500/40' : ''} />
      </div>

      {summary.over && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
          <AlertTriangle className="h-4 w-4" /> {t('tripBudget.youAreOverBudgetIn')} {summary.categories.filter((c) => c.over).map((c) => lookup(BUDGET_CATEGORIES, c.category).label).join(', ')}.
        </div>
      )}

      <div className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Wallet className="h-5 w-5 text-brand-text" /> {t('tripBudget.budgetByCategory')}</h2>
        <div className="space-y-2">
          {BUDGET_CATEGORIES.map((cat) => {
            const roll = summary.categories.find((c) => c.category === cat.value);
            const planned = plannedByCat.get(cat.value)?.planned_cents ?? 0;
            const spent = roll?.spent_cents ?? 0;
            const pct = planned > 0 ? Math.round((spent / planned) * 100) : (spent > 0 ? 100 : 0);
            return (
              <div key={cat.value} className="rounded-xl border border-border bg-surface/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{cat.emoji} {cat.label}</span>
                  {editing === cat.value ? (
                    <span className="flex items-center gap-1">
                      <Input type="number" step="0.01" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => savePlanned(cat.value)} onKeyDown={(e) => e.key === 'Enter' && savePlanned(cat.value)} className="h-8 w-28" />
                    </span>
                  ) : (
                    <button onClick={() => { setEditing(cat.value); setDraft(planned ? String(planned / 100) : ''); }} className="text-sm text-muted hover:text-brand-text">
                      {dollars(spent)} / {dollars(planned)} ✎
                    </button>
                  )}
                </div>
                <div className="mt-2"><Progress pct={pct} tone={pct > 100 ? 'bg-rose-500' : pct > 85 ? 'bg-amber-500' : 'bg-brand'} /></div>
              </div>
            );
          })}
        </div>
      </div>

      <TripCrudSection<Expense>
        table="vacation_expenses" vacationId={vacationId} title={t('tripBudget.expenses')} icon={Receipt}
        fields={expenseFields} emptyText="No expenses logged" addLabel="Log expense"
        orderBy={(a, b) => b.spent_on.localeCompare(a.spent_on)}
        renderRow={(x, members) => {
          const who = x.paid_by_member_id ? members.get(x.paid_by_member_id)?.display_name : null;
          return (
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{x.description}</p>
                <p className="mt-0.5 text-xs text-muted">{[lookup(BUDGET_CATEGORIES, x.category).label, fmtDate(x.spent_on), who].filter(Boolean).join(' · ')}</p>
              </div>
              <span className="shrink-0 font-semibold">{dollars(x.amount_cents)}</span>
            </div>
          );
        }}
      />
    </div>
  );
}

