'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { BarChart3, Plane, Wallet, Gauge } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { ErrorState, LoadingBlock, EmptyState } from '@/components/ui/states';
import { StatPill, Progress } from './shared';
import { VACATION_KINDS, dollars, lookup } from '@/lib/vacations/meta';
import { daysUntil } from '@/lib/vacations/dates';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Trip = Tables<'vacations'>;
type Expense = Tables<'vacation_expenses'>;
type Budget = Tables<'vacation_budgets'>;
type Score = Tables<'vacation_travel_scores'>;

export function VacationsReports() {
  const tr = useTranslations();
  const { familyId } = useApp();
  const { data: trips, loading: tripsLoading, error: tripsError, refresh: refreshTrips } = useRealtimeQuery<Trip>({ table: 'vacations', familyId, deps: [familyId], fetcher: (sb) => sb.from('vacations').select('*').eq('family_id', familyId) });
  const { data: expenses, loading: expensesLoading, error: expensesError, refresh: refreshExpenses } = useRealtimeQuery<Expense>({ table: 'vacation_expenses', familyId, deps: [familyId], fetcher: (sb) => sb.from('vacation_expenses').select('*').eq('family_id', familyId) });
  const { data: budgets, loading: budgetsLoading, error: budgetsError, refresh: refreshBudgets } = useRealtimeQuery<Budget>({ table: 'vacation_budgets', familyId, deps: [familyId], fetcher: (sb) => sb.from('vacation_budgets').select('*').eq('family_id', familyId) });
  const { data: scores, loading: scoresLoading, error: scoresError, refresh: refreshScores } = useRealtimeQuery<Score>({ table: 'vacation_travel_scores', familyId, deps: [familyId], fetcher: (sb) => sb.from('vacation_travel_scores').select('*').eq('family_id', familyId) });

  const refreshAll = () => {
    void Promise.all([refreshTrips(), refreshExpenses(), refreshBudgets(), refreshScores()]);
  };

  const spentByTrip = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of expenses) m.set(e.vacation_id, (m.get(e.vacation_id) ?? 0) + e.amount_cents);
    return m;
  }, [expenses]);
  const plannedByTrip = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of budgets) m.set(b.vacation_id, (m.get(b.vacation_id) ?? 0) + b.planned_cents);
    return m;
  }, [budgets]);
  const latestScore = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of [...scores].sort((a, b) => (a.computed_at < b.computed_at ? -1 : 1))) m.set(s.vacation_id, s.score);
    return m;
  }, [scores]);

  const totalPlanned = [...plannedByTrip.values()].reduce((s, x) => s + x, 0);
  const totalSpent = [...spentByTrip.values()].reduce((s, x) => s + x, 0);
  const upcoming = trips.filter((t) => (daysUntil(t.start_date) ?? -1) >= 0 && t.status !== 'cancelled').length;

  const byKind = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of trips) m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [trips]);
  const maxKind = Math.max(1, ...byKind.map(([, n]) => n));

  if (tripsLoading || expensesLoading || budgetsLoading || scoresLoading) return <LoadingBlock />;
  if (tripsError || expensesError || budgetsError || scoresError) {
    return <ErrorState message={tr('vacationsReports.couldNotLoadCompleteVacation')} onRetry={refreshAll} />;
  }
  if (trips.length === 0) return <EmptyState icon={BarChart3} title={tr('vacationsReports.noTripsToReportOnYet')} description={tr('vacationsReports.createAVacationToSee')} />;

  return (
    <div className="space-y-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold"><BarChart3 className="h-6 w-6 text-brand-text" /> {tr('vacationsReports.vacationReports')}</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatPill label={tr('vacationsReports.totalTrips')} value={<span className="flex items-center gap-1"><Plane className="h-4 w-4 text-muted" /> {trips.length}</span>} />
        <StatPill label={tr('vacationsReports.upcoming')} value={upcoming} />
        <StatPill label={tr('vacationsReports.plannedBudget')} value={dollars(totalPlanned)} />
        <StatPill label={tr('vacationsReports.totalSpent')} value={dollars(totalSpent)} />
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><BarChart3 className="h-4 w-4 text-brand-text" /> {tr('vacationsReports.tripsByType')}</h2>
        <div className="space-y-2">
          {byKind.map(([kind, n]) => (
            <div key={kind} className="flex items-center gap-3">
              <span className="w-32 shrink-0 text-sm">{lookup(VACATION_KINDS, kind as Trip['kind']).emoji} {lookup(VACATION_KINDS, kind as Trip['kind']).label}</span>
              <div className="flex-1"><Progress pct={(n / maxKind) * 100} /></div>
              <span className="w-6 text-right text-sm text-muted">{n}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4 text-brand-text" /> {tr('vacationsReports.perTripBudgetVsSpend')}</h2>
        <div className="space-y-3">
          {trips.map((t) => {
            const planned = plannedByTrip.get(t.id) ?? 0, spent = spentByTrip.get(t.id) ?? 0;
            const pct = planned > 0 ? Math.round((spent / planned) * 100) : (spent > 0 ? 100 : 0);
            return (
              <Link key={t.id} href={`/dashboard/vacations/${t.id}/budget`} className="block">
                <div className="flex items-center justify-between text-sm"><span className="font-medium">{t.title}</span>
                  <span className="text-muted">{dollars(spent)} / {dollars(planned)} {latestScore.has(t.id) && <span className="ml-2"><Gauge className="inline h-3 w-3" /> {latestScore.get(t.id)}%</span>}</span>
                </div>
                <div className="mt-1"><Progress pct={pct} tone={pct > 100 ? 'bg-rose-500' : 'bg-brand'} /></div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

