import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, TrendingUp, TrendingDown, Sparkles, ArrowRight } from 'lucide-react';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { computeReadiness, BAND_LABEL, type ReadinessInput } from '@/lib/readiness/score';
import { assessReadiness, overallReadiness, type ReadinessSignals } from '@/lib/readiness/assess';
import { calendarReadiness } from '@/lib/readiness/calendar-source';
import type { Evidence, ReadinessCoverage } from '@/lib/readiness/assess';
import { ReadinessHorizons } from '@/components/modules/readiness-module';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Readiness' };
export const dynamic = 'force-dynamic';

const BAND_COLOR = {
  great: 'text-emerald-400', good: 'text-blue-400', attention: 'text-amber-400', at_risk: 'text-rose-400',
} as const;

export default async function ReadinessPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
  const todayStr = now.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  const [
    choresOverdueRes,
    remindersOverdueRes,
    mealsRes,
    eventsUpcomingRes,
    activeMembersRes,
    famPlanLevel,
  ] = await Promise.all([
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', now.toISOString()),
    supabase.from('reminders').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_done', false).lt('remind_at', now.toISOString()),
    supabase.from('meal_plans').select('plan_date').eq('family_id', familyId).gte('plan_date', todayStr).lte('plan_date', weekEndStr),
    supabase.from('calendar_events').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('starts_at', now.toISOString()).lt('starts_at', weekEnd.toISOString()),
    supabase.from('family_members').select('id', { count: 'exact' }).eq('family_id', familyId).eq('is_active', true).order('id').limit(200),
    resolveFamilyPlanLevel(supabase, familyId),
  ]);

  // The headline readiness SCORE is source-of-truth: if any of its six inputs
  // failed to read, fail closed rather than compute a reassuring-but-wrong score
  // (a dropped overdue-chores read would otherwise render as "all caught up").
  // Calendar/roster completeness is also checked before displaying the score.
  const primaryError = [
    choresOverdueRes.error,
    remindersOverdueRes.error,
    mealsRes.error,
    eventsUpcomingRes.error,
    activeMembersRes.error,
  ].find(Boolean);
  if (primaryError) {
    console.error('[dashboard/readiness] readiness score read failed', primaryError);
    return <ErrorState message={t('readiness.couldNotLoadYourFamily')} />;
  }

  const input: ReadinessInput = {
    choresOverdue: choresOverdueRes.count ?? 0,
    remindersOverdue: remindersOverdueRes.count ?? 0,
    mealsPlanned: new Set((mealsRes.data ?? []).map((m) => m.plan_date)).size,
    eventsUpcoming: eventsUpcomingRes.count ?? 0,
    activeMembers: activeMembersRes.count ?? 0,
  };
  const { score, band, factors } = computeReadiness(input);
  const isPlus = (await effectivePlanLevel(famPlanLevel)) >= 2;

  // Legacy non-calendar horizon counts remain best-effort. Calendar coverage
  // is explicit: a failed or capped read cannot establish that a week is clear.
  const tomorrowKey = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const monthEndKey = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  // A failed read and a genuinely quiet week both arrive as zero, and the §51
  // card now makes positive claims ("Documents are current"). So each of these
  // reports whether it succeeded, and the assessor is told which sources it can
  // and cannot speak for.
  //
  // An ABSENT count is not a confirmed zero either. A `head: true` count query
  // carries its answer in the Content-Range header, and supabase-js reports a
  // missing or unparseable header as `{ count: null, error: null }` — no error
  // to catch. Coercing that to 0 would turn "we could not count your documents"
  // into "your documents are current", which is precisely the claim §51 must
  // never invent.
  //
  // So `known` is not "no error" but "a number a count could actually be": a
  // safe non-negative integer. NaN, ±Infinity, 0.5 and -1 all come from a header
  // that was parsed wrongly, not from a household that has -1 documents, and
  // each one would otherwise be believed. Rejecting the shape rather than
  // enumerating the failures is what makes the next malformed header safe too.
  const cnt = async (q: PromiseLike<{ count: number | null; error: unknown }>): Promise<{ value: number; known: boolean }> => {
    const { count: n, error } = await q;
    if (error || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return { value: 0, known: false };
    return { value: n, known: true };
  };
  const [
    tomorrowEventsRes, weekEventsRes, dinnerTomorrowRes, overduePrepSteps, billsDueWeek,
    expiringDocsMonth, upcomingTripsMonth, openPrepPlans,
  ] = await Promise.all([
    supabase.from('calendar_events').select('id, starts_at, ends_at, all_day, assignee_id', { count: 'exact' })
      .eq('family_id', familyId).gte('starts_at', `${tomorrowKey}T00:00:00Z`).lt('starts_at', `${tomorrowKey}T23:59:59Z`),
    // Exact accessible-row count detects both this cap and server-side limits.
    supabase.from('calendar_events').select('id, starts_at, ends_at, all_day, assignee_id', { count: 'exact' })
      .eq('family_id', familyId).gte('starts_at', `${todayStr}T00:00:00Z`).lte('starts_at', `${weekEndStr}T23:59:59Z`)
      .order('starts_at').limit(200),
    cnt(supabase.from('meal_plans').select('plan_date', { count: 'exact', head: true }).eq('family_id', familyId).eq('plan_date', tomorrowKey).eq('meal_type', 'dinner')),
    cnt(supabase.from('prep_plan_steps').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('is_done', false).lt('due_date', todayStr)),
    cnt(supabase.from('bills').select('id', { count: 'exact', head: true }).eq('family_id', familyId).neq('status', 'paid').lte('due_date', weekEndStr)),
    cnt(supabase.from('documents').select('id', { count: 'exact', head: true }).eq('family_id', familyId).not('expires_at', 'is', null).gte('expires_at', todayStr).lte('expires_at', monthEndKey)),
    cnt(supabase.from('vacations').select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('start_date', todayStr).lte('start_date', monthEndKey)),
    cnt(supabase.from('prep_plans').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'active')),
  ]);
  const tomorrowCalendar = calendarReadiness(tomorrowEventsRes);
  const weeklyCalendar = calendarReadiness(weekEventsRes, activeMembersRes);
  // The rest of the sources, in the same vocabulary. `cnt` swallowed a failure
  // into a zero, which the ✓ list would have reported as "Documents are
  // current".
  const readCoverage: Partial<Record<Evidence, ReadinessCoverage>> = {};
  if (!dinnerTomorrowRes.known) readCoverage.meals_tomorrow = 'unknown';
  if (!mealsRes.data) readCoverage.meals_week = 'unknown';
  if (!overduePrepSteps.known) readCoverage.prep_steps = 'unknown';
  if (!openPrepPlans.known) readCoverage.prep_plans = 'unknown';
  if (!billsDueWeek.known) readCoverage.bills = 'unknown';
  if (!expiringDocsMonth.known) readCoverage.documents = 'unknown';
  if (!upcomingTripsMonth.known) readCoverage.trips = 'unknown';

  const coverageIncomplete = [
    tomorrowCalendar.calendarCoverage, weeklyCalendar.calendarCoverage, weeklyCalendar.workloadCoverage,
    ...Object.values(readCoverage),
  ].some((coverage) => coverage !== 'complete');

  const plannedThisWeek = new Set((mealsRes.data ?? []).map((m) => m.plan_date));
  const unplannedDinnersWeek = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10))
    .filter((d) => !plannedThisWeek.has(d)).length;
  const signals: ReadinessSignals = {
    tomorrowConflicts: tomorrowCalendar.conflicts, tomorrowUnassigned: tomorrowCalendar.unassigned,
    dinnerPlannedTomorrow: dinnerTomorrowRes.value > 0,
    conflictsWeek: weeklyCalendar.conflicts, unplannedDinnersWeek,
    overduePrepSteps: overduePrepSteps.value, billsDueWeek: billsDueWeek.value,
    expiringDocsMonth: expiringDocsMonth.value, overloadedMembers: weeklyCalendar.overloadedMembers,
    upcomingTripsMonth: upcomingTripsMonth.value, openPrepPlans: openPrepPlans.value,
    tomorrowCalendarCoverage: tomorrowCalendar.calendarCoverage,
    weekCalendarCoverage: weeklyCalendar.calendarCoverage,
    workloadCoverage: weeklyCalendar.workloadCoverage,
    coverage: readCoverage,
  };
  const horizonCards = assessReadiness(signals);

  // SVG ring math for the activity panel below. It is NOT greyed by horizon
  // coverage: its own six inputs are primary reads that fail the whole page
  // (`primaryError`), so it is never assembled from a source that failed. The
  // readiness answer above reports its own coverage, per source.
  const r = 54, c = 2 * Math.PI * r, dash = (score / 100) * c;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-brand-text" />
        <h1 className="text-lg font-bold">{t('dashboardReadiness.familyReadiness')}</h1>
      </div>

      {/* §51's readiness, and the only thing on this page that answers "are we
          ready?". It used to sit BELOW a second, larger 0–100 ring computed by
          `lib/readiness/score.ts` under the same word, so a family could read
          "78 · Looking good" and "40 · Not ready" on one screen about what
          looked like one question. That score is a real measure of a different
          thing — how much the household is currently doing in the app — and it
          keeps its place further down under a name that says so. */}
      <div>
        <p className="mb-3 text-sm text-muted">{t('dashboardReadiness.calendarAndWorkloadChecksUseOnly')}</p>
        {coverageIncomplete && (
          <p role="status" className="mb-3 rounded-xl border border-border bg-surface/40 p-3 text-sm text-amber-300">
            {t('dashboardReadiness.readinessIsNotConfirmedWhileSome')}
          </p>
        )}
        <ReadinessHorizons cards={horizonCards} overall={overallReadiness(horizonCards)} />
      </div>

      <div className="grid gap-4 pt-1 lg:grid-cols-3">
        <div className="flex flex-col items-center justify-center rounded-3xl border border-border bg-surface/40 p-6">
          <svg viewBox="0 0 128 128" className="h-40 w-40 -rotate-90">
            <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="12" className="text-elevated" />
            <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round"
              strokeDasharray={`${dash} ${c}`} className={BAND_COLOR[band]} />
          </svg>
          <p className={`-mt-28 text-4xl font-black ${BAND_COLOR[band]}`}>{score}</p>
          <p className="mt-20 text-sm font-semibold">{BAND_LABEL[band]}</p>
        </div>

        <div className="rounded-3xl border border-border bg-surface/40 p-6 lg:col-span-2">
          <h2 className="text-base font-semibold">{t('dashboardReadiness.howMuchYourFamilyIsRunning')}</h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            A measure of activity — planned meals, an up-to-date calendar, chores kept on top of. Not the same question as
            &ldquo;are we ready?&rdquo; above, which is about what is still open. Its own six inputs are required reads, so
            this number is never assembled from a source that failed.
          </p>
          {factors.length === 0 ? (
            <p className="text-sm text-muted">{t('dashboardReadiness.addEventsChoresAndMealsTo')}</p>
          ) : (
            <ul className="space-y-2">
              {factors.map((f, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  {f.good ? <TrendingUp className="h-4 w-4 shrink-0 text-emerald-400" /> : <TrendingDown className="h-4 w-4 shrink-0 text-rose-400" />}
                  <span className="flex-1">{f.label}</span>
                  {f.delta !== 0 && <span className={`tabular-nums ${f.good ? 'text-emerald-400' : 'text-rose-400'}`}>{f.delta > 0 ? '+' : ''}{f.delta}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!isPlus && (
        <Link href="/dashboard/billing?upgrade=1&need=2" className="group flex items-center gap-4 rounded-3xl border border-brand/30 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 transition hover:border-brand/50">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15"><Sparkles className="h-5 w-5 text-brand-text" /></div>
          <div className="flex-1">
            <p className="font-semibold">{t('dashboardReadiness.wantTheFullPicture')}</p>
            <p className="text-sm text-muted">{t('dashboardReadiness.familyAddsLiveStressAmpOperations')}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-text" />
        </Link>
      )}
    </div>
  );
}
