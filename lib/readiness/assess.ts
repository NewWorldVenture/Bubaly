// Life Readiness assessment (pure, unit-tested, DB-free).
//
// The vision's shift from information to preparedness: instead of showing data,
// answer "are we ready for tomorrow? this week? this month?". This rolls up live
// signals from across the app (schedule, meals, prep plans, bills, documents,
// load) into one readiness verdict per horizon, with the specific gaps to close.
// Pure + deterministic; the server page fills the signals from real tables.

export type Horizon = 'tomorrow' | 'week' | 'month';
export type ReadinessStatus = 'ready' | 'at_risk' | 'not_ready';

export type ReadinessSignals = {
  // tomorrow
  tomorrowConflicts: number;
  tomorrowUnassigned: number;
  dinnerPlannedTomorrow: boolean;
  // this week
  conflictsWeek: number;
  unplannedDinnersWeek: number;
  overduePrepSteps: number;
  billsDueWeek: number;
  // this month
  expiringDocsMonth: number;
  overloadedMembers: number;
  upcomingTripsMonth: number;
  openPrepPlans: number;
};

export const EMPTY_READINESS_SIGNALS: ReadinessSignals = {
  tomorrowConflicts: 0, tomorrowUnassigned: 0, dinnerPlannedTomorrow: true,
  conflictsWeek: 0, unplannedDinnersWeek: 0, overduePrepSteps: 0, billsDueWeek: 0,
  expiringDocsMonth: 0, overloadedMembers: 0, upcomingTripsMonth: 0, openPrepPlans: 0,
};

export type GapSeverity = 'blocker' | 'watch';
export type ReadinessGap = { label: string; href: string; severity: GapSeverity };

export type ReadinessCard = {
  horizon: Horizon;
  title: string;
  status: ReadinessStatus;
  headline: string;
  score: number;        // 0..100
  gaps: ReadinessGap[]; // blockers first
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function finalize(horizon: Horizon, title: string, gaps: ReadinessGap[]): ReadinessCard {
  const blockers = gaps.filter((g) => g.severity === 'blocker').length;
  const watches = gaps.filter((g) => g.severity === 'watch').length;
  const status: ReadinessStatus = blockers > 0 ? 'not_ready' : watches > 0 ? 'at_risk' : 'ready';
  const score = Math.max(0, Math.min(100, 100 - blockers * 35 - watches * 15));
  const ordered = [...gaps].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1));
  const headline =
    status === 'ready' ? readyHeadline(horizon)
    : blockers > 0 ? `${plural(blockers, 'thing')} to fix${watches ? ` and ${plural(watches, 'to watch', 'to watch')}` : ''}.`
    : `${plural(watches, 'thing')} worth a look.`;
  return { horizon, title, status, headline, score, gaps: ordered };
}

function readyHeadline(h: Horizon): string {
  return h === 'tomorrow' ? "You're set for tomorrow."
    : h === 'week' ? 'The week is under control.'
    : 'The month ahead looks prepared.';
}

/** Roll live signals into three readiness cards (tomorrow, week, month). */
export function assessReadiness(s: ReadinessSignals): ReadinessCard[] {
  // Tomorrow.
  const tomorrow: ReadinessGap[] = [];
  if (s.tomorrowConflicts > 0) tomorrow.push({ label: `${plural(s.tomorrowConflicts, 'schedule clash', 'schedule clashes')} tomorrow`, href: '/dashboard/conflicts', severity: 'blocker' });
  if (s.tomorrowUnassigned > 0) tomorrow.push({ label: `${plural(s.tomorrowUnassigned, 'event')} with no owner`, href: '/dashboard/calendar', severity: 'watch' });
  if (!s.dinnerPlannedTomorrow) tomorrow.push({ label: "Tomorrow's dinner isn't planned", href: '/dashboard/meals', severity: 'watch' });

  // This week.
  const week: ReadinessGap[] = [];
  if (s.conflictsWeek > 0) week.push({ label: `${plural(s.conflictsWeek, 'clash', 'clashes')} this week`, href: '/dashboard/conflicts', severity: 'blocker' });
  if (s.overduePrepSteps > 0) week.push({ label: `${plural(s.overduePrepSteps, 'prep step')} overdue`, href: '/dashboard/prep-plans', severity: 'blocker' });
  if (s.unplannedDinnersWeek >= 3) week.push({ label: `${plural(s.unplannedDinnersWeek, 'dinner')} unplanned`, href: '/dashboard/meals', severity: 'watch' });
  if (s.billsDueWeek > 0) week.push({ label: `${plural(s.billsDueWeek, 'bill')} due`, href: '/dashboard/bills', severity: 'watch' });

  // This month.
  const month: ReadinessGap[] = [];
  if (s.expiringDocsMonth > 0) month.push({ label: `${plural(s.expiringDocsMonth, 'document')} expiring`, href: '/dashboard/documents', severity: 'blocker' });
  if (s.openPrepPlans > 0) month.push({ label: `${plural(s.openPrepPlans, 'prep plan')} in progress`, href: '/dashboard/prep-plans', severity: 'watch' });
  if (s.overloadedMembers > 0) month.push({ label: `${plural(s.overloadedMembers, 'person')} carrying a heavy load`, href: '/dashboard/family-operating-index', severity: 'watch' });
  if (s.upcomingTripsMonth > 0) month.push({ label: `${plural(s.upcomingTripsMonth, 'trip')} to prep`, href: '/dashboard/prep-plans', severity: 'watch' });

  return [
    finalize('tomorrow', 'Ready for tomorrow?', tomorrow),
    finalize('week', 'Ready for this week?', week),
    finalize('month', 'Ready for this month?', month),
  ];
}

/** Overall readiness = the lowest card score (weakest-link), plus a one-liner. */
export function overallReadiness(cards: ReadinessCard[]): { score: number; status: ReadinessStatus } {
  if (cards.length === 0) return { score: 100, status: 'ready' };
  const score = Math.min(...cards.map((c) => c.score));
  const status: ReadinessStatus = cards.some((c) => c.status === 'not_ready') ? 'not_ready'
    : cards.some((c) => c.status === 'at_risk') ? 'at_risk' : 'ready';
  return { score, status };
}
