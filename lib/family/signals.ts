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
import { readCompleteCalendarOccurrences } from '@/lib/services/calendar/search-occurrences';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '@/lib/calendar/source-capability';
import { addDaysToDayKey, dayKeyInTz, zonedDayBoundsMs, zonedTimeMs } from '@/lib/services/scope';
import { computeStress, type StressInput, type StressResult } from './stress';
import { completionScore, nextBestActions, type NextAction } from './operations';
import { readOnOpenGroceryLists } from '@/lib/services/groceries';
import { isWithheldFromGuest } from '@/lib/auth/guest-scope';

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
    /**
     * The viewer is a guest, whom guest-scope keeps out of the household's
     * money (ROLE-SCOPE-001): the bill counts were not read, are 0, and are
     * left out of stress, completion and the actions. A page shows no bill
     * figure at all for a withheld read — "0 of 0 bills paid" is a claim.
     */
    billsWithheld: boolean;
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

/** Who the counts are for. Omitted, nothing is withheld (the AI context and other server readers). */
export type SignalsViewer = { role: string };

type HeadCount = { count: number | null; error: unknown };

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
  viewer?: SignalsViewer,
): Promise<FamilySignalsResult> {
  const supabase = await createServer();
  const { todayKey, weekEndKey, startIso, endIso, in3Iso, in7Iso } = signalWindow(tz, now);
  // A guest is not read the household's bills, as /dashboard/bills and
  // /dashboard/family-cfo refuse them (lib/auth/guest-scope).
  const billsWithheld = viewer?.role === 'guest' && isWithheldFromGuest('/dashboard/bills');
  // The bill and open-chore figures are exact counts. They were row reads
  // with no bound, so past PostgREST's 1,000-row cap "X of Y bills paid" and
  // the open/overdue chores were an arbitrary prefix presented as totals.
  const billsQuery = () => supabase.from('bills').select('id', { count: 'exact', head: true }).eq('family_id', familyId);
  const billCount = (narrow: (query: ReturnType<typeof billsQuery>) => PromiseLike<HeadCount>): PromiseLike<HeadCount> =>
    billsWithheld ? Promise.resolve({ count: 0, error: null }) : narrow(billsQuery());
  const openChores = () => supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
    .eq('family_id', familyId).in('status', ['todo', 'in_progress']);

  const [
    weekEvents,
    appts,
    openTasks,
    overdueTaskCount,
    dueTodayTaskCount,
    doneTasks,
    totalTasks,
    billTotal,
    overdueBillCount,
    dueSoonBillCount,
    paidBillCount,
    homework,
    sports,
    routines,
    meals,
    grocery,
  ] = await settleAll([
    (async () => {
      const unavailable = (message: string) => ({ data: null, error: { message } });
      if (CALENDAR_SOURCE_ARCHIVE_ENABLED) return unavailable('Family signals imported-source calendars are not supported yet.');
      const result = await readCompleteCalendarOccurrences({ db: supabase, familyId, tz,
        userId: null, memberId: null, role: 'system', actorKind: 'system',
      }, { from: startIso, to: in7Iso });
      if (!result.ok) return unavailable(result.error);
      const native = result.data.occurrences.filter(row => row.kind === 'native');
      if (native.length !== result.data.occurrences.length) return unavailable('Family signals require a native calendar domain.');
      // Preserve the existing start-based histogram and inclusive seventh-day
      // boundary, rather than turning ongoing spans into daily workload counts.
      // Complete qualification also checks ongoing rows before this selection.
      return { data: native.filter(row => row.all_day
        ? row.startDate! >= todayKey && row.startDate! <= weekEndKey
        : Date.parse(row.actualStartsAt) >= Date.parse(startIso) && Date.parse(row.actualStartsAt) <= Date.parse(in7Iso)), error: null };
    })(),
    supabase.from('appointments').select('id, starts_at')
      .eq('family_id', familyId).gte('starts_at', startIso).lt('starts_at', endIso),
    openChores(),
    // `due_at` is a nullable timestamptz; the family's midnight bounds both
    // (a chore with no due date is neither overdue nor due today).
    openChores().lt('due_at', startIso),
    openChores().gte('due_at', startIso).lt('due_at', endIso),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['done', 'approved']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId),
    billCount((query) => query),
    billCount((query) => query.eq('status', 'overdue')),
    // `due_date` is a DATE column — already the family's day, so it is compared
    // as it arrives. Converting it would be the mirror-image bug.
    billCount((query) => query.eq('status', 'upcoming').gte('due_date', todayKey).lte('due_date', weekEndKey)),
    billCount((query) => query.eq('status', 'paid')),
    supabase.from('school_events').select('id')
      .eq('family_id', familyId).gte('starts_at', startIso).lte('starts_at', in3Iso),
    supabase.from('sports_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', startIso).lte('starts_at', in7Iso),
    supabase.from('family_routines').select('days_of_week')
      .eq('family_id', familyId).eq('status', 'active'),
    supabase.from('meal_plans').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('plan_date', todayKey).lte('plan_date', weekEndKey),
    // Only lists the family has not archived (readOnOpenGroceryLists).
    readOnOpenGroceryLists(supabase, familyId, (lists) => supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('list_id', lists).eq('is_checked', false)),
  ]);

  const exactCounts = [openTasks, overdueTaskCount, dueTodayTaskCount, billTotal, overdueBillCount, dueSoonBillCount, paidBillCount];
  const readError = [weekEvents, appts, ...exactCounts, doneTasks, totalTasks, homework, sports, routines, meals, grocery]
    .find((result) => result.error)?.error
    ?? (exactCounts.some((result) => typeof result.count !== 'number') ? new Error('Family signal counts were incomplete') : null);
  if (readError) return { data: null, error: readError };

  // Per-day event histogram → busiest day + back-to-back transitions.
  const byDay = new Map<string, number>();
  const times: number[] = [];
  for (const e of weekEvents.data ?? []) {
    const day = e.all_day ? e.startDate! : dayKeyInTz(new Date(e.actualStartsAt), tz);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    // A civil DATE has no appointment clock and cannot create a timed
    // back-to-back transition merely because it is stored at UTC midnight.
    if (!e.all_day) times.push(Date.parse(e.actualStartsAt));
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

  const overdueTasks = overdueTaskCount.count ?? 0;
  const dueTodayTasks = dueTodayTaskCount.count ?? 0;

  const overdueBills = overdueBillCount.count ?? 0;
  const billsDueSoon = dueSoonBillCount.count ?? 0;
  const billsPaid = paidBillCount.count ?? 0;

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
    openTasks: openTasks.count ?? 0,
    doneTasks: doneTasks.count ?? 0,
    totalTasks: totalTasks.count ?? 0,
    overdueBills,
    billsDueSoon,
    billsPaid,
    billsTotal: billTotal.count ?? 0,
    billsWithheld,
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
