// Life Readiness assessment (pure, unit-tested, DB-free) — §51's signature
// feature.
//
// The vision's shift from information to preparedness: instead of showing data,
// answer "are we ready for tomorrow? this week? this month?". This rolls up live
// signals from across the app (schedule, meals, prep plans, bills, documents,
// load) into one readiness verdict per horizon, with the specific gaps to close.
// Pure + deterministic; the server page fills the signals from real tables.
//
// EVERY RULE STATES BOTH SIDES. §51's card is "Ready: ✓ lunches planned,
// ✓ calendar clear" above "Missing: ○ permission slip" — a family needs to see
// what is handled, not only what is not, or the page is a list of failures
// however well the week is going. Each rule below therefore declares its gap
// AND what to say when it is clear, in one place, so the two can never drift.
//
// A CLEAR RULE IS NOT ALWAYS WORTH SAYING. "No bills due this week" and "no
// trips to prep" are absences, not accomplishments, and padding the ✓ column
// with them would make a quiet week look like an achievement and a real ✓ worth
// less. Those rules set `clear: null` and simply stay off both lists.

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
/** §51's "Ready: ✓ …" — a check this household has actually passed. */
export type ReadinessCheck = { label: string; href: string };

export type ReadinessCard = {
  horizon: Horizon;
  title: string;
  status: ReadinessStatus;
  headline: string;
  score: number;         // 0..100
  ready: ReadinessCheck[]; // what is handled
  gaps: ReadinessGap[];    // what is not, blockers first
  /** The sentence to hand Bubaly when a person presses "Let Bubaly handle it". */
  handleIt: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One readiness rule: is it failing, what to call the failure, and what to call
 * it when clear. `clear: null` means the passing state is an absence rather
 * than an accomplishment and belongs on neither list.
 */
type Rule = {
  failing: boolean;
  gap: () => Omit<ReadinessGap, 'href'>;
  clear: string | null;
  href: string;
};

function split(rules: Rule[]): { ready: ReadinessCheck[]; gaps: ReadinessGap[] } {
  const ready: ReadinessCheck[] = [];
  const gaps: ReadinessGap[] = [];
  for (const rule of rules) {
    if (rule.failing) gaps.push({ ...rule.gap(), href: rule.href });
    else if (rule.clear) ready.push({ label: rule.clear, href: rule.href });
  }
  return { ready, gaps };
}

function finalize(horizon: Horizon, title: string, rules: Rule[]): ReadinessCard {
  const { ready, gaps } = split(rules);
  const blockers = gaps.filter((g) => g.severity === 'blocker').length;
  const watches = gaps.filter((g) => g.severity === 'watch').length;
  const status: ReadinessStatus = blockers > 0 ? 'not_ready' : watches > 0 ? 'at_risk' : 'ready';
  const score = Math.max(0, Math.min(100, 100 - blockers * 35 - watches * 15));
  const ordered = [...gaps].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1));
  const headline =
    status === 'ready' ? readyHeadline(horizon)
    : blockers > 0 ? `${plural(blockers, 'thing')} to fix${watches ? ` and ${plural(watches, 'to watch', 'to watch')}` : ''}.`
    : `${plural(watches, 'thing')} worth a look.`;
  return { horizon, title, status, headline, score, ready, gaps: ordered, handleIt: handleItFor(horizon, ordered) };
}

function readyHeadline(h: Horizon): string {
  return h === 'tomorrow' ? "You're set for tomorrow."
    : h === 'week' ? 'The week is under control.'
    : 'The month ahead looks prepared.';
}

/**
 * §51's [Let Bubaly Handle It]. The sentence names the gaps rather than the
 * horizon alone, because "get us ready for tomorrow" gives the planner nothing
 * to work from while "sort out the schedule clash and plan tomorrow's dinner"
 * is a request it can turn into steps a person can read before they run.
 */
export const HANDLE_IT_WINDOW: Record<Horizon, string> = {
  tomorrow: 'tomorrow', week: 'this week', month: 'this month',
};

function handleItFor(horizon: Horizon, gaps: ReadinessGap[]): string {
  const window = HANDLE_IT_WINDOW[horizon];
  if (gaps.length === 0) return `Is there anything I should be doing about ${window}?`;
  const list = gaps.map((g) => g.label.toLowerCase());
  const spoken = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `Help me get ready for ${window}: ${spoken}.`;
}

/** Roll live signals into three readiness cards (tomorrow, week, month). */
export function assessReadiness(s: ReadinessSignals): ReadinessCard[] {
  const tomorrow: Rule[] = [
    {
      failing: s.tomorrowConflicts > 0, href: '/dashboard/conflicts',
      gap: () => ({ label: `${plural(s.tomorrowConflicts, 'schedule clash', 'schedule clashes')} tomorrow`, severity: 'blocker' }),
      clear: 'Calendar is clear',
    },
    {
      failing: s.tomorrowUnassigned > 0, href: '/dashboard/calendar',
      gap: () => ({ label: `${plural(s.tomorrowUnassigned, 'event')} with no owner`, severity: 'watch' }),
      clear: 'Everything has an owner',
    },
    {
      failing: !s.dinnerPlannedTomorrow, href: '/dashboard/meals',
      gap: () => ({ label: "Tomorrow's dinner isn't planned", severity: 'watch' }),
      clear: "Tomorrow's dinner is planned",
    },
  ];

  const week: Rule[] = [
    {
      failing: s.conflictsWeek > 0, href: '/dashboard/conflicts',
      gap: () => ({ label: `${plural(s.conflictsWeek, 'clash', 'clashes')} this week`, severity: 'blocker' }),
      clear: 'No clashes this week',
    },
    {
      failing: s.overduePrepSteps > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.overduePrepSteps, 'prep step')} overdue`, severity: 'blocker' }),
      clear: 'Prep is on schedule',
    },
    {
      failing: s.unplannedDinnersWeek >= 3, href: '/dashboard/meals',
      gap: () => ({ label: `${plural(s.unplannedDinnersWeek, 'dinner')} unplanned`, severity: 'watch' }),
      // Only a ✓ when the week is genuinely planned. Between one and two
      // unplanned dinners is neither a gap worth raising nor an achievement.
      clear: s.unplannedDinnersWeek === 0 ? 'The week of dinners is planned' : null,
    },
    {
      failing: s.billsDueWeek > 0, href: '/dashboard/bills',
      gap: () => ({ label: `${plural(s.billsDueWeek, 'bill')} due`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

  const month: Rule[] = [
    {
      failing: s.expiringDocsMonth > 0, href: '/dashboard/documents',
      gap: () => ({ label: `${plural(s.expiringDocsMonth, 'document')} expiring`, severity: 'blocker' }),
      clear: 'Documents are current',
    },
    {
      failing: s.openPrepPlans > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.openPrepPlans, 'prep plan')} in progress`, severity: 'watch' }),
      clear: null, // A plan in progress is work in hand, not a failure to have none.
    },
    {
      failing: s.overloadedMembers > 0, href: '/dashboard/family-operating-index',
      gap: () => ({ label: `${plural(s.overloadedMembers, 'person')} carrying a heavy load`, severity: 'watch' }),
      clear: 'The load is spread evenly',
    },
    {
      failing: s.upcomingTripsMonth > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.upcomingTripsMonth, 'trip')} to prep`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

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
