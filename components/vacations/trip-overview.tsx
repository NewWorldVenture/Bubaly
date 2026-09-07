'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Gauge, Sparkles, RefreshCw, Lightbulb, Wallet, CloudSun, CheckCircle2, Plane, BedDouble, Ticket, FolderLock } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { StatPill, Progress } from './shared';
import { ReadinessRing } from './vacations-list';
import { computeReadiness } from '@/lib/vacations/readiness';
import { summarizeBudget } from '@/lib/vacations/budget';
import { tripWeatherAdvice, type WeatherDayLike } from '@/lib/vacations/weather';
import { dateRange, countdownLabel } from '@/lib/vacations/dates';
import { dollars, RECO_META } from '@/lib/vacations/meta';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

const q = <T,>(table: string, familyId: string, vacationId: string) => ({
  table, familyId, deps: [familyId, vacationId],
  fetcher: (sb: any) => sb.from(table).select('*').eq('family_id', familyId).eq('vacation_id', vacationId) as PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
});

export function TripOverview({ vacationId }: { vacationId: string }) {
  const tr = useTranslations();
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();

  const tripQuery = useRealtimeQuery<Tables<'vacations'>>({ table: 'vacations', familyId, deps: [familyId, vacationId], fetcher: (sb) => sb.from('vacations').select('*').eq('id', vacationId) });
  const membersQuery = useRealtimeQuery<Tables<'vacation_members'>>(q('vacation_members', familyId, vacationId));
  const lodgingQuery = useRealtimeQuery<Tables<'vacation_lodging'>>(q('vacation_lodging', familyId, vacationId));
  const flightsQuery = useRealtimeQuery<Tables<'vacation_flights'>>(q('vacation_flights', familyId, vacationId));
  const transportQuery = useRealtimeQuery<Tables<'vacation_transportation'>>(q('vacation_transportation', familyId, vacationId));
  const activitiesQuery = useRealtimeQuery<Tables<'vacation_activities'>>(q('vacation_activities', familyId, vacationId));
  const reservationsQuery = useRealtimeQuery<Tables<'vacation_reservations'>>(q('vacation_reservations', familyId, vacationId));
  const budgetsQuery = useRealtimeQuery<Tables<'vacation_budgets'>>(q('vacation_budgets', familyId, vacationId));
  const expensesQuery = useRealtimeQuery<Tables<'vacation_expenses'>>(q('vacation_expenses', familyId, vacationId));
  const packingQuery = useRealtimeQuery<Tables<'vacation_packing_items'>>(q('vacation_packing_items', familyId, vacationId));
  const docsQuery = useRealtimeQuery<Tables<'vacation_documents'>>(q('vacation_documents', familyId, vacationId));
  const emergencyQuery = useRealtimeQuery<Tables<'vacation_emergency_contacts'>>(q('vacation_emergency_contacts', familyId, vacationId));
  const daysQuery = useRealtimeQuery<Tables<'vacation_itinerary_days'>>(q('vacation_itinerary_days', familyId, vacationId));
  const itemsQuery = useRealtimeQuery<Tables<'vacation_itinerary_items'>>(q('vacation_itinerary_items', familyId, vacationId));
  const weatherQuery = useRealtimeQuery<Tables<'vacation_weather_snapshots'>>(q('vacation_weather_snapshots', familyId, vacationId));
  const recosQuery = useRealtimeQuery<Tables<'vacation_ai_recommendations'>>(q('vacation_ai_recommendations', familyId, vacationId));

  const readQueries = [
    tripQuery, membersQuery, lodgingQuery, flightsQuery, transportQuery, activitiesQuery,
    reservationsQuery, budgetsQuery, expensesQuery, packingQuery, docsQuery, emergencyQuery,
    daysQuery, itemsQuery, weatherQuery, recosQuery,
  ];
  const tripRows = tripQuery.data;
  const trip = tripRows[0];
  const members = membersQuery.data;
  const lodging = lodgingQuery.data;
  const flights = flightsQuery.data;
  const transport = transportQuery.data;
  const activities = activitiesQuery.data;
  const reservations = reservationsQuery.data;
  const budgets = budgetsQuery.data;
  const expenses = expensesQuery.data;
  const packing = packingQuery.data;
  const docs = docsQuery.data;
  const emergency = emergencyQuery.data;
  const days = daysQuery.data;
  const items = itemsQuery.data;
  const weather = weatherQuery.data;
  const recos = recosQuery.data;
  const loading = readQueries.some((query) => query.loading);
  const readError = readQueries.some((query) => query.error);
  const refreshAll = () => { void Promise.all(readQueries.map((query) => query.refresh())); };

  const budget = useMemo(() => summarizeBudget(budgets, expenses), [budgets, expenses]);
  const transportTotal = flights.length + transport.length;
  const transportBooked = flights.filter((f) => f.booked).length + transport.filter((t) => t.booked).length;
  const daysWithItems = new Set(items.map((i) => i.day_id).filter(Boolean)).size;

  const readiness = useMemo(() => computeReadiness({
    hasDates: !!(trip?.start_date && trip?.end_date), membersCount: members.length,
    lodgingTotal: lodging.length, lodgingBooked: lodging.filter((l) => l.booked).length,
    transportTotal, transportBooked,
    activitiesTotal: activities.length, activitiesBooked: activities.filter((a) => a.booked).length,
    reservationsTotal: reservations.length, reservationsBooked: reservations.filter((r) => r.booked).length,
    packingTotal: packing.length, packingPacked: packing.filter((p) => p.packed).length,
    documentsCount: docs.length, emergencyContactsCount: emergency.length,
    budgetPlannedCents: budget.planned_cents, itineraryDays: daysWithItems,
    // INCLUSIVE days, matching `lib/services/trips computeReadiness`. This read
    // `tripNights` — end minus start — while the server used
    // `dateRange(...).length`, always one more. The itinerary factor is
    // `daysWithItems / tripDays` and `daysWithItems` counts `vacation_days`
    // rows, which are the inclusive dates, so the nights denominator inflated
    // the score here and the same trip scored differently in the AI card.
    tripDays: trip?.start_date && trip?.end_date ? dateRange(trip.start_date, trip.end_date).length : 0,
    isInternational: trip?.is_international ?? false,
  }), [trip, members, lodging, transportTotal, transportBooked, activities, reservations, packing, docs, emergency, budget, daysWithItems]);

  // Persist the latest score so the trips list can display it (insert only when changed).
  const lastSaved = useRef<number | null>(null);
  useEffect(() => {
    if (loading || !trip) return;
    if (lastSaved.current === readiness.score) return;
    lastSaved.current = readiness.score;
    (async () => {
      const sb = createClient();
      const { data: latest } = await sb.from('vacation_travel_scores').select('score').eq('vacation_id', vacationId).order('computed_at', { ascending: false }).limit(1).maybeSingle();
      if (latest?.score === readiness.score) return;
      await sb.from('vacation_travel_scores').insert({ family_id: familyId, vacation_id: vacationId, score: readiness.score, breakdown: readiness.factors as never });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness.score, loading, trip, familyId, vacationId]);

  const weatherAdvice = useMemo(() => tripWeatherAdvice(weather as WeatherDayLike[]), [weather]);
  const openRecos = recos.filter((r) => r.status === 'open').sort((a, b) => b.severity - a.severity);
  const [refreshing, setRefreshing] = useState(false);

  async function refreshRecos() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/vacations/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'recommendations', vacationId }) });
      const data = await res.json();
      if (!res.ok) toastError(data.error || 'Failed'); else success(`${data.count} recommendations`);
    } catch { toastError('Network error'); }
    setRefreshing(false);
  }

  async function dismissReco(id: string) {
    const { error } = await createClient().from('vacation_ai_recommendations').update({ status: 'dismissed' }).eq('id', id);
    if (error) toastError(error.message);
  }

  if (loading) return <LoadingBlock />;
  if (readError) return <ErrorState message="Could not load this trip overview. Refresh and try again." onRetry={refreshAll} />;

  const lvlLabel = { not_started: 'Not started', getting_there: 'Getting there', almost_ready: 'Almost ready', ready: 'Ready to go!' }[readiness.level];

  return (
    <div className="space-y-6">
      {/* readiness */}
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <ReadinessRing score={readiness.score} />
          <div className="flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Gauge className="h-5 w-5 text-brand-text" /> {tr('tripOverview.vacationReadiness')} {lvlLabel}</h2>
            <p className="text-sm text-muted">{countdownLabel(trip?.start_date)} · {members.length} traveler{members.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {readiness.factors.map((f) => (
            <div key={f.key} className="rounded-xl border border-border/60 bg-elevated/30 p-2.5">
              <div className="mb-1 flex items-center justify-between text-xs"><span className="font-medium">{f.label}</span><span className="text-muted">{f.score}%</span></div>
              <Progress pct={f.score} tone={f.score >= 90 ? 'bg-emerald-500' : f.score >= 50 ? 'bg-brand' : 'bg-amber-500'} />
            </div>
          ))}
        </div>
        {readiness.recommendations.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-muted">
            {readiness.recommendations.slice(0, 3).map((r, i) => <li key={i} className="flex items-start gap-1.5"><Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" /> {r}</li>)}
          </ul>
        )}
      </div>

      {/* quick stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Link href={`/dashboard/vacations/${vacationId}/lodging`}><StatPill label={tr('tripOverview.lodging')} value={<span className="flex items-center gap-1"><BedDouble className="h-4 w-4 text-muted" /> {lodging.length}</span>} /></Link>
        <Link href={`/dashboard/vacations/${vacationId}/travel`}><StatPill label={tr('tripOverview.travel')} value={<span className="flex items-center gap-1"><Plane className="h-4 w-4 text-muted" /> {transportTotal}</span>} /></Link>
        <Link href={`/dashboard/vacations/${vacationId}/activities`}><StatPill label={tr('tripOverview.activities')} value={<span className="flex items-center gap-1"><Ticket className="h-4 w-4 text-muted" /> {activities.length}</span>} /></Link>
        <Link href={`/dashboard/vacations/${vacationId}/documents`}><StatPill label={tr('tripOverview.documents')} value={<span className="flex items-center gap-1"><FolderLock className="h-4 w-4 text-muted" /> {docs.length}</span>} /></Link>
      </div>

      {/* recommendations */}
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="h-5 w-5 text-brand-text" /> {tr('tripOverview.aiRecommendations')}</h2>
          <Button size="sm" variant="secondary" onClick={refreshRecos} loading={refreshing}><RefreshCw className="h-4 w-4" /> {tr('tripOverview.refresh')}</Button>
        </div>
        {openRecos.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> {tr('tripOverview.noOpenRecommendationsTapRefreshTo')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {openRecos.slice(0, 8).map((r) => {
              const meta = RECO_META[r.kind] ?? { label: r.kind, emoji: '•' };
              const tone = r.severity >= 3 ? 'border-rose-500/30' : r.severity === 2 ? 'border-amber-500/30' : 'border-border';
              return (
                <li key={r.id} className={`flex items-start justify-between gap-3 rounded-xl border ${tone} bg-elevated/30 p-3`}>
                  <div><p className="text-sm font-medium">{meta.emoji} {r.title}</p>{r.detail && <p className="mt-0.5 text-xs text-muted">{r.detail}</p>}</div>
                  <button onClick={() => dismissReco(r.id)} className="shrink-0 text-xs text-muted hover:text-fg">Dismiss</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* budget + weather summary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Link href={`/dashboard/vacations/${vacationId}/budget`} className="rounded-2xl border border-border bg-surface/40 p-5 transition hover:border-brand/40">
          <h3 className="flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4 text-brand-text" /> {tr('tripOverview.budget')}</h3>
          <p className="mt-2 text-2xl font-bold">{dollars(budget.spent_cents)} <span className="text-sm font-normal text-muted">/ {dollars(budget.planned_cents)}</span></p>
          <div className="mt-2"><Progress pct={budget.pct === 999 ? 100 : budget.pct} tone={budget.over ? 'bg-rose-500' : 'bg-brand'} /></div>
          {budget.over && <p className="mt-1 text-xs text-rose-300">{tr('tripOverview.overBudgetIn')} {budget.categories.filter((c) => c.over).length} categor{budget.categories.filter((c) => c.over).length === 1 ? 'y' : 'ies'}</p>}
        </Link>
        <Link href={`/dashboard/vacations/${vacationId}/weather`} className="rounded-2xl border border-border bg-surface/40 p-5 transition hover:border-brand/40">
          <h3 className="flex items-center gap-2 font-semibold"><CloudSun className="h-4 w-4 text-brand-text" /> {tr('tripOverview.weather')}</h3>
          {weather.length === 0 ? <p className="mt-2 text-sm text-muted">{tr('tripOverview.noForecastYetFetchOneOn')}</p> : (
            <ul className="mt-2 space-y-1 text-sm">
              {weatherAdvice.slice(0, 3).map((a, i) => <li key={i} className="text-muted">• {a.text}</li>)}
              {weatherAdvice.length === 0 && <li className="text-muted">{tr('tripOverview.looksPleasantNoAlerts')}</li>}
            </ul>
          )}
        </Link>
      </div>
    </div>
  );
}

