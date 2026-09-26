// lib/family/signals.ts  (SERVER)
// Gathers the real Supabase counts that power the Operations, Stress and
// Autonomous Management surfaces. One round of queries, shared by all three.
//
// Every day key in this file is the FAMILY's day, which is why `tz` is a
// parameter rather than something the file reads off the server. It used to
// take `.slice(0, 10)` of a timestamptz — the day at GREENWICH — and compare it
// against a `todayStr` built from the SERVER's midnight. Both halves were wrong
// and they were wrong differently, so the errors did not cancel:
//
//   - `starts_at.slice(0, 10)` on an event at 22:00 in Los Angeles answers
//     TOMORROW, so "events today" silently dropped every evening's events.
//   - `todayStr` was `new Date(localMidnight).toISOString().slice(0, 10)`, so on
//     a server east of UTC it was YESTERDAY's key, and on Vercel (UTC) it was
//     the Greenwich day — never the family's.
//   - `due_at.slice(0, 10) < todayStr` therefore reported a chore that is
//     genuinely overdue in Los Angeles as "due today", which is the difference
//     between a nudge and a missed deadline.
//
// `bills.due_date` and `meal_plans.plan_date` are DATE columns (0006 and 0002):
// PostgREST hands those over as a bare `YYYY-MM-DD` that is ALREADY the
// family's day, so they are compared against the family day key untouched — no
// conversion, because there is no instant to convert.
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { addDaysToDayKey, dayKeyInTz, zonedTimeMs } from '@/lib/services/scope';
import { computeStress, type StressInput, type StressResult } from './stress';
import { completionScore, nextBestActions, type NextAction } from './operations';

/**
 * The family-local window every query below is bounded by.
 *
 * Exported because it is the whole of the timezone reasoning and it is pure —
 * a test can pin an instant and two zones and check the bounds without a
 * database. The horizons advance the day KEY and then resolve local midnight
 * again, rather than adding 7 × 86_400_000 ms: the week that crosses a
 * fall-back is 169 hours long, so the fixed-millisecond form lands at 23:00 the
 * evening before and formats as the previous day.
 */
export type SignalWindow = {
  /** Today on the family's wall, `YYYY-MM-DD`. */
  todayKey: string;
  /** Today + 7 days as a day key — the bound for the DATE columns. */
  weekEndKey: string;
  /** Local midnight today, as an instant. */
  startIso: string;
  /** Local midnight tomorrow (exclusive end of "today"). */
  endIso: string;
  /** Local midnight today + 3 days. */
  in3Iso: string;
  /** Local midnight today + 7 days. */
  in7Iso: string;
};

export function signalWindow(tz: string, now: Date): SignalWindow {
  const todayKey = dayKeyInTz(now, tz);
  const ahead = (days: number) => addDaysToDayKey(todayKey, days);
  const midnight = (dayKey: string) => new Date(zonedTimeMs(dayKey, 0, 0, tz)).toISOString();
  return {
    todayKey,
    weekEndKey: ahead(7),
    startIso: midnight(todayKey),
    endIso: midnight(ahead(1)),
    in3Iso: midnight(ahead(3)),
    in7Iso: midnight(ahead(7)),
  };
}

export type FamilySignals = {
  stress: StressResult;
  completion: number;
  actions: NextAction[];
  counts: {
    eventsToday: number;
    maxEventsPerDay: number;
    appointmentsToday: number;
    overdueTasks: number;
    dueTodayTasks: number;
    openTasks: number;
    doneTasks: number;
    totalTasks: number;
    overdueBills: number;
    billsDueSoon: number;
    billsPaid: number;
    billsTotal: number;
    homeworkDueSoon: number;
    sportsThisWeek: number;
    routinesTotal: number;
    plannedMeals: number;
    emptyGrocery: boolean;
  };
};

export type FamilySignalsResult = {
  data: FamilySignals | null;
  error: unknown | null;
};

/**
 * `tz` is the family's IANA zone — `ctx.active.family.timezone` on a page,
 * `scope.tz` in a service. It is required rather than defaulted because every
 * caller has a family in hand, and a silent 'UTC' default would put this file
 * straight back to answering Greenwich's question.
 */
export async function gatherSignalsResult(
  familyId: string,
  tz: string,
  now: Date = new Date(),
): Promise<FamilySignalsResult> {
  const supabase = await createServer();
  const { todayKey, weekEndKey, startIso, endIso, in3Iso, in7Iso } = signalWindow(tz, now);

  const [
    weekEvents,
    appts,
    openTasks,
    doneTasks,
    totalTasks,
    bills,
    homework,
    sports,
    routines,
    meals,
    grocery,
  ] = await settleAll([
    supabase.from('calendar_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', startIso).lte('starts_at', in7Iso),
    supabase.from('appointments').select('id, starts_at')
      .eq('family_id', familyId).gte('starts_at', startIso).lt('starts_at', endIso),
    supabase.from('chore_assignments').select('due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['done', 'approved']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId),
    supabase.from('bills').select('status, due_date').eq('family_id', familyId),
    supabase.from('school_events').select('id')
      .eq('family_id', familyId).gte('starts_at', startIso).lte('starts_at', in3Iso),
    supabase.from('sports_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', startIso).lte('starts_at', in7Iso),
    supabase.from('family_routines').select('days_of_week')
      .eq('family_id', familyId).eq('status', 'active'),
    supabase.from('meal_plans').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_checked', false),
  ]);

  const readError = [weekEvents, appts, openTasks, doneTasks, totalTasks, bills, homework, sports, routines, meals, grocery]
    .find((result) => result.error)?.error;
  if (readError) return { data: null, error: readError };

  // Per-day event histogram → busiest day + back-to-back transitions.
  const byDay = new Map<string, number>();
  const times: number[] = [];
  for (const e of weekEvents.data ?? []) {
    const day = dayKeyInTz(new Date(e.starts_at), tz);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    times.push(new Date(e.starts_at).getTime());
  }
  const maxEventsPerDay = byDay.size ? Math.max(...byDay.values()) : 0;
  const eventsToday = byDay.get(todayKey) ?? 0;
  times.sort((a, b) => a - b);
  let backToBackPairs = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < 30 * 60 * 1000) backToBackPairs++;
  }

  // Sports same-day collisions = sports events sharing a day with another event.
  const sportsByDay = new Map<string, number>();
  for (const s of sports.data ?? []) {
    const day = dayKeyInTz(new Date(s.starts_at), tz);
    sportsByDay.set(day, (sportsByDay.get(day) ?? 0) + 1);
  }
  let sportsConflicts = 0;
  for (const [day, count] of sportsByDay) {
    const total = (byDay.get(day) ?? 0) + count;
    if (total > 1) sportsConflicts += count;
  }

  const openRows = openTasks.data ?? [];
  // `due_at` is a nullable timestamptz: the null check stays (a chore with no
  // due date is neither overdue nor due today), and the instant is resolved on
  // the family's wall before it is compared with the family's today.
  const dueDayKey = (t: { due_at: string | null }) => (t.due_at ? dayKeyInTz(new Date(t.due_at), tz) : null);
  const overdueTasks = openRows.filter((t) => { const key = dueDayKey(t); return key !== null && key < todayKey; }).length;
  const dueTodayTasks = openRows.filter((t) => dueDayKey(t) === todayKey).length;

  const billRows = bills.data ?? [];
  const overdueBills = billRows.filter((b) => b.status === 'overdue').length;
  const billsDueSoon = billRows.filter(
    // `due_date` is a DATE column — already the family's day, so it is compared
    // as it arrives. Converting it would be the mirror-image bug.
    (b) => b.status === 'upcoming' && b.due_date >= todayKey && b.due_date <= weekEndKey,
  ).length;
  const billsPaid = billRows.filter((b) => b.status === 'paid').length;

  const stressInput: StressInput = {
    maxEventsPerDay,
    backToBackPairs,
    overdueTasks,
    schoolDeadlines: homework.data?.length ?? 0,
    sportsConflicts,
    upcomingAppointments: appts.data?.length ?? 0,
    billsDueSoon: overdueBills + billsDueSoon,
  };
  const stress = computeStress(stressInput);

  const counts = {
    eventsToday,
    maxEventsPerDay,
    appointmentsToday: appts.data?.length ?? 0,
    overdueTasks,
    dueTodayTasks,
    openTasks: openRows.length,
    doneTasks: doneTasks.count ?? 0,
    totalTasks: totalTasks.count ?? 0,
    overdueBills,
    billsDueSoon,
    billsPaid,
    billsTotal: billRows.length,
    homeworkDueSoon: homework.data?.length ?? 0,
    sportsThisWeek: sports.data?.length ?? 0,
    routinesTotal: routines.data?.length ?? 0,
    plannedMeals: meals.count ?? 0,
    emptyGrocery: (grocery.count ?? 0) === 0,
  };

  const completion = completionScore({
    choresDone: counts.doneTasks,
    choresTotal: counts.totalTasks,
    billsPaid: counts.billsPaid,
    billsTotal: counts.billsTotal,
    homeworkDone: 0,
    homeworkTotal: counts.homeworkDueSoon,
    routinesOnTrack: counts.routinesTotal,
    routinesTotal: counts.routinesTotal,
  });

  const actions = nextBestActions({
    overdueTasks,
    dueTodayTasks,
    overdueBills,
    billsDueSoon,
    appointmentsToday: counts.appointmentsToday,
    homeworkDueSoon: counts.homeworkDueSoon,
    stressLevel: stress.level,
    emptyGrocery: counts.emptyGrocery,
    plannedMeals: counts.plannedMeals,
  });

  return { data: { stress, completion, actions, counts }, error: null };
}

export async function gatherSignals(familyId: string, tz: string, now: Date = new Date()): Promise<FamilySignals> {
  const result = await gatherSignalsResult(familyId, tz, now);
  if (result.error || !result.data) throw result.error ?? new Error('Family signal reads failed');
  return result.data;
}
