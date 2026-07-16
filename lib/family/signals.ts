// lib/family/signals.ts  (SERVER)
// Gathers the real Supabase counts that power the Operations, Stress and
// Autonomous Management surfaces. One round of queries, shared by all three.
import { createServer } from '@/lib/supabase/server';
import { computeStress, type StressInput, type StressResult } from './stress';
import { completionScore, nextBestActions, type NextAction } from './operations';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);

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

export async function gatherSignalsResult(familyId: string): Promise<FamilySignalsResult> {
  const supabase = await createServer();
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const todayStr = ymd(start);
  const end = new Date(start.getTime() + DAY);
  const in3 = new Date(start.getTime() + 3 * DAY);
  const in7 = new Date(start.getTime() + 7 * DAY);

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
  ] = await Promise.all([
    supabase.from('calendar_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', iso(start)).lte('starts_at', iso(in7)),
    supabase.from('appointments').select('id, starts_at')
      .eq('family_id', familyId).gte('starts_at', iso(start)).lt('starts_at', iso(end)),
    supabase.from('chore_assignments').select('due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['done', 'approved']),
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId),
    supabase.from('bills').select('status, due_date').eq('family_id', familyId),
    supabase.from('school_events').select('id')
      .eq('family_id', familyId).gte('starts_at', iso(start)).lte('starts_at', iso(in3)),
    supabase.from('sports_events').select('starts_at')
      .eq('family_id', familyId).gte('starts_at', iso(start)).lte('starts_at', iso(in7)),
    supabase.from('family_routines').select('days_of_week')
      .eq('family_id', familyId).eq('status', 'active'),
    supabase.from('meal_plans').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).gte('plan_date', todayStr).lte('plan_date', ymd(in7)),
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
    const day = e.starts_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    times.push(new Date(e.starts_at).getTime());
  }
  const maxEventsPerDay = byDay.size ? Math.max(...byDay.values()) : 0;
  const eventsToday = byDay.get(todayStr) ?? 0;
  times.sort((a, b) => a - b);
  let backToBackPairs = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < 30 * 60 * 1000) backToBackPairs++;
  }

  // Sports same-day collisions = sports events sharing a day with another event.
  const sportsByDay = new Map<string, number>();
  for (const s of sports.data ?? []) {
    const day = s.starts_at.slice(0, 10);
    sportsByDay.set(day, (sportsByDay.get(day) ?? 0) + 1);
  }
  let sportsConflicts = 0;
  for (const [day, count] of sportsByDay) {
    const total = (byDay.get(day) ?? 0) + count;
    if (total > 1) sportsConflicts += count;
  }

  const openRows = openTasks.data ?? [];
  const overdueTasks = openRows.filter((t) => t.due_at && t.due_at.slice(0, 10) < todayStr).length;
  const dueTodayTasks = openRows.filter((t) => t.due_at && t.due_at.slice(0, 10) === todayStr).length;

  const billRows = bills.data ?? [];
  const overdueBills = billRows.filter((b) => b.status === 'overdue').length;
  const billsDueSoon = billRows.filter(
    (b) => b.status === 'upcoming' && b.due_date >= todayStr && b.due_date <= ymd(in7),
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

export async function gatherSignals(familyId: string): Promise<FamilySignals> {
  const result = await gatherSignalsResult(familyId);
  if (result.error || !result.data) throw result.error ?? new Error('Family signal reads failed');
  return result.data;
}
