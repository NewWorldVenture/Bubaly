import type { Metadata } from 'next';
import Link from 'next/link';
import { Gauge, TrendingUp, TrendingDown, Sparkles, ArrowRight } from 'lucide-react';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { computeReadiness, BAND_LABEL, type ReadinessInput } from '@/lib/readiness/score';
import { assessReadiness, overallReadiness, type Evidence, type ReadinessSignals } from '@/lib/readiness/assess';
import { detectConflicts, type TimedEvent } from '@/lib/family/conflicts';
import { mostLoaded } from '@/lib/operating-index/score';
import { ReadinessHorizons } from '@/components/modules/readiness-module';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Family Readiness' };
export const dynamic = 'force-dynamic';

const BAND_COLOR = {
  great: 'text-emerald-400', good: 'text-blue-400', attention: 'text-amber-400', at_risk: 'text-rose-400',
} as const;

export default async function ReadinessPage() {
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
  // (The forward horizon block below is deliberately best-effort — see `cnt`.)
  const primaryError = [
    choresOverdueRes.error,
    remindersOverdueRes.error,
    mealsRes.error,
    eventsUpcomingRes.error,
    activeMembersRes.error,
  ].find(Boolean);
  if (primaryError) {
    console.error('[dashboard/readiness] readiness score read failed', primaryError);
    return <ErrorState message="Could not load your family readiness from Supabase. Refresh and try again." />;
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

  // Forward-looking horizon readiness (tomorrow / week / month). Counts are
  // best-effort — a table from an unapplied migration yields 0, never an error
  // — but "best effort" and "nothing to report" are different answers, and the
  // §51 card now makes positive claims ("Documents are current"). So each read
  // reports whether it actually succeeded, and `unavailable` carries the ones
  // that did not through to the assessor, which then says the check could not
  // be run rather than that it passed.
  const tomorrowKey = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const monthEndKey = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const cnt = async (q: PromiseLike<{ count: number | null; error: unknown }>): Promise<{ value: number; known: boolean }> => {
    const { count: n, error } = await q;
    return error ? { value: 0, known: false } : { value: n ?? 0, known: true };
  };
  const [
    tomorrowEventsRes, weekEventsRes, dinnerTomorrowRes, overduePrepSteps, billsDueWeek,
    expiringDocsMonth, upcomingTripsMonth, openPrepPlans,
  ] = await Promise.all([
    supabase.from('calendar_events').select('id, starts_at, ends_at, all_day, assignee_id', { count: 'exact' })
      .eq('family_id', familyId).gte('starts_at', `${tomorrowKey}T00:00:00Z`).lt('starts_at', `${tomorrowKey}T23:59:59Z`),
    // The week, for the card that claims to know about the week. It used to be
    // told `conflictsWeek: 0` as a literal, so it could never report a clash.
    // `count: 'exact'` so a week with more events than the cap is known to be
    // truncated rather than quietly reported as fully measured.
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
  const tEvents = (tomorrowEventsRes.data ?? []) as TimedEvent[];
  const weekEvents = (weekEventsRes.data ?? []) as TimedEvent[];
  // THE COUNT MUST MATCH THE PAGE IT SENDS YOU TO. The gap reads "2 clashes
  // this week" and links to /dashboard/conflicts, which runs
  // `lib/family/conflicts.ts detectConflicts`. This page had its own copy of
  // that sweep, so the two could — and did — disagree about the same week.
  // (The Family Operating Index deliberately uses a DIFFERENT rule,
  // `lib/home/conflicts.ts`: one PERSON double-booked, which is a different
  // question and has its own page. Two named rules, each used consistently,
  // rather than a third written here.)
  const tomorrowConflicts = detectConflicts(tEvents).length;
  const conflictsWeek = detectConflicts(weekEvents).length;

  // Likewise for "someone is carrying a heavy load": the gap links to the
  // Family Operating Index, so it answers with that page's own rule
  // (`mostLoaded`) rather than a second threshold written here — which could
  // send a person to a page that names nobody. It identifies at most one
  // member, so this is 0 or 1 by construction.
  // SEEDED FROM THE ROSTER, not from who happens to own an event. Counting
  // only event owners meant eight things on one parent and nothing on the
  // other two produced an average over `[8]` — so the one person carrying the
  // whole week was never "clearly above the family average" and nobody was
  // named. The people carrying nothing are exactly what makes it an imbalance.
  const perMember = new Map<string, number>();
  for (const m of activeMembersRes.data ?? []) perMember.set(m.id, 0);
  for (const e of weekEvents) {
    if (e.all_day || !e.assignee_id) continue;
    // An assignee outside the accessible roster is not another zero-load
    // member; leaving them out is what keeps the average honest.
    if (!perMember.has(e.assignee_id)) continue;
    perMember.set(e.assignee_id, perMember.get(e.assignee_id)! + 1);
  }
  const overloadedMembers = mostLoaded(
    // `openTasks: 0` on purpose, and worth stating: the Family Operating Index
    // feeds `mostLoaded` events AND open tasks, so this is the same RULE over a
    // narrower input, not the same answer. It can therefore name nobody where
    // that page would — never the reverse — which is the safe direction for a
    // gap whose whole job is to send someone there.
    [...perMember.entries()].map(([memberId, upcoming]) => ({ memberId, name: memberId, upcoming, openTasks: 0 })),
  ) ? 1 : 0;

  // WHAT WE ACTUALLY MANAGED TO READ. A failed query and a genuinely quiet week
  // both arrive as zero; only this tells them apart, and the §51 card needs the
  // difference the moment it starts saying "Documents are current".
  const weekTruncated = typeof weekEventsRes.count === 'number' && weekEventsRes.count > weekEvents.length;
  const unavailable: Evidence[] = [];
  if (tomorrowEventsRes.error) unavailable.push('calendar_tomorrow');
  if (weekEventsRes.error || weekTruncated) unavailable.push('calendar_week');
  // The roster is a primary read (a failure already fails the page above), so
  // the workload is unknown only when the week it is measured over is.
  if (!dinnerTomorrowRes.known) unavailable.push('meals_tomorrow');
  if (!mealsRes.data) unavailable.push('meals_week');
  if (!overduePrepSteps.known) unavailable.push('prep_steps');
  if (!openPrepPlans.known) unavailable.push('prep_plans');
  if (!billsDueWeek.known) unavailable.push('bills');
  if (!expiringDocsMonth.known) unavailable.push('documents');
  if (!upcomingTripsMonth.known) unavailable.push('trips');

  const plannedThisWeek = new Set((mealsRes.data ?? []).map((m) => m.plan_date));
  const unplannedDinnersWeek = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10))
    .filter((d) => !plannedThisWeek.has(d)).length;
  const signals: ReadinessSignals = {
    tomorrowConflicts, tomorrowUnassigned: tEvents.filter((e) => !e.assignee_id).length,
    dinnerPlannedTomorrow: dinnerTomorrowRes.value > 0,
    conflictsWeek, unplannedDinnersWeek,
    overduePrepSteps: overduePrepSteps.value, billsDueWeek: billsDueWeek.value,
    expiringDocsMonth: expiringDocsMonth.value, overloadedMembers,
    upcomingTripsMonth: upcomingTripsMonth.value, openPrepPlans: openPrepPlans.value,
    unavailable,
  };
  const horizonCards = assessReadiness(signals);

  // SVG ring math for the activity panel below.
  const r = 54, c = 2 * Math.PI * r, dash = (score / 100) * c;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-brand-text" />
        <h1 className="text-lg font-bold">Family Readiness</h1>
      </div>

      {/* §51's readiness, and the only thing on this page that answers "are we
          ready?". It used to sit BELOW a second, larger 0–100 ring computed by
          `lib/readiness/score.ts` under the same word, so a family could read
          "78 · Looking good" and "40 · Not ready" on one screen about what
          looked like one question. That score is a real measure of a different
          thing — how much the household is currently doing in the app — and it
          keeps its place further down under a name that says so. */}
      <ReadinessHorizons cards={horizonCards} overall={overallReadiness(horizonCards)} />

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
          <h2 className="text-base font-semibold">How much your family is running through Bubaly</h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            A measure of activity — planned meals, an up-to-date calendar, chores kept on top of. Not the same question as
            &ldquo;are we ready?&rdquo; above, which is about what is still open.
          </p>
          {factors.length === 0 ? (
            <p className="text-sm text-muted">Add events, chores, and meals to see what shapes this.</p>
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
            <p className="font-semibold">Want the full picture?</p>
            <p className="text-sm text-muted">Family+ adds live Stress &amp; Operations scores, predictive alerts, and the AI Command Center.</p>
          </div>
          <ArrowRight className="h-5 w-5 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-text" />
        </Link>
      )}
    </div>
  );
}

