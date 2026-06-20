// lib/family/operations.ts
// Pure helpers for the Operations command center: a single "family completion
// score" and a derived next-best-action list. Fed by real Supabase counts.

export type OpsSnapshot = {
  choresDone: number;
  choresTotal: number;
  billsPaid: number;
  billsTotal: number;
  homeworkDone: number;
  homeworkTotal: number;
  routinesOnTrack: number;
  routinesTotal: number;
};

/**
 * Weighted completion across the household's trackable commitments. Returns a
 * 0–100 integer. Dimensions with nothing to track are ignored so an empty
 * household does not read as "0% done".
 */
export function completionScore(s: OpsSnapshot): number {
  const dims: Array<[number, number, number]> = [
    [s.choresDone, s.choresTotal, 0.4],
    [s.billsPaid, s.billsTotal, 0.25],
    [s.homeworkDone, s.homeworkTotal, 0.2],
    [s.routinesOnTrack, s.routinesTotal, 0.15],
  ];
  let weighted = 0;
  let weightSum = 0;
  for (const [done, total, weight] of dims) {
    if (total <= 0) continue;
    weighted += (done / total) * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return 100; // nothing to do == fully on top of things
  return Math.round((weighted / weightSum) * 100);
}

export type ActionPriority = 'high' | 'medium' | 'low';
export type NextAction = {
  id: string;
  title: string;
  detail: string;
  href: string;
  priority: ActionPriority;
};

export type ActionInputs = {
  overdueTasks: number;
  dueTodayTasks: number;
  overdueBills: number;
  billsDueSoon: number;
  appointmentsToday: number;
  homeworkDueSoon: number;
  stressLevel: 'low' | 'moderate' | 'elevated' | 'high';
  emptyGrocery: boolean;
  plannedMeals: number;
};

const RANK: Record<ActionPriority, number> = { high: 0, medium: 1, low: 2 };

/** Derives concrete, drill-in next actions from real counts — never fabricated. */
export function nextBestActions(i: ActionInputs): NextAction[] {
  const out: NextAction[] = [];
  if (i.overdueBills > 0) {
    out.push({ id: 'overdue-bills', priority: 'high', href: '/dashboard/family-cfo',
      title: `${i.overdueBills} bill${i.overdueBills > 1 ? 's' : ''} overdue`,
      detail: 'Pay or reschedule before late fees hit.' });
  }
  if (i.overdueTasks > 0) {
    out.push({ id: 'overdue-tasks', priority: 'high', href: '/dashboard/family-coo',
      title: `${i.overdueTasks} task${i.overdueTasks > 1 ? 's' : ''} overdue`,
      detail: 'Reassign or close them out to clear the backlog.' });
  }
  if (i.appointmentsToday > 0) {
    out.push({ id: 'appts-today', priority: 'high', href: '/dashboard/family-health',
      title: `${i.appointmentsToday} appointment${i.appointmentsToday > 1 ? 's' : ''} today`,
      detail: 'Confirm timing, transport, and any forms.' });
  }
  if (i.stressLevel === 'high' || i.stressLevel === 'elevated') {
    out.push({ id: 'stress', priority: i.stressLevel === 'high' ? 'high' : 'medium', href: '/dashboard/family-stress',
      title: `Family load is ${i.stressLevel}`,
      detail: 'Review suggested reschedules to lighten the week.' });
  }
  if (i.homeworkDueSoon > 0) {
    out.push({ id: 'homework', priority: 'medium', href: '/dashboard/family-school',
      title: `${i.homeworkDueSoon} school deadline${i.homeworkDueSoon > 1 ? 's' : ''} soon`,
      detail: 'Block focus time before they pile up.' });
  }
  if (i.billsDueSoon > 0) {
    out.push({ id: 'bills-soon', priority: 'medium', href: '/dashboard/family-cfo',
      title: `${i.billsDueSoon} bill${i.billsDueSoon > 1 ? 's' : ''} due this week`,
      detail: 'Schedule the payments now.' });
  }
  if (i.dueTodayTasks > 0) {
    out.push({ id: 'due-today', priority: 'medium', href: '/dashboard/family-coo',
      title: `${i.dueTodayTasks} task${i.dueTodayTasks > 1 ? 's' : ''} due today`,
      detail: 'Knock these out before the day fills up.' });
  }
  if (i.plannedMeals > 0 && i.emptyGrocery) {
    out.push({ id: 'grocery', priority: 'low', href: '/dashboard/grocery',
      title: 'Meals planned, grocery list empty',
      detail: 'Generate the shopping list from this week’s meals.' });
  }
  return out.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
}
