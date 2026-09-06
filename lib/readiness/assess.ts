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
//
// AND A ✓ IS A CLAIM, SO IT NEEDS COMPLETE EVIDENCE. Every signal arrives from
// a read that can fail or come back truncated, and a failure looks exactly like
// a quiet week: zero. That was harmless while the card only listed gaps —
// nothing to report reads the same as nothing wrong. The moment a zero became
// "Calendar is clear" it stopped being harmless. So each rule names the
// `Evidence` it rests on, the page reports how completely it read each source,
// and a ✓ is only offered on `complete`. On `partial` a gap still reports what
// IS known, as a lower bound ("At least 1 clash"); on `unknown` the rule says
// nothing at all and the horizon reports that the check could not be run.
export type Horizon = 'tomorrow' | 'week' | 'month';
export type ReadinessStatus = 'ready' | 'at_risk' | 'not_ready';
export type ReadinessCoverage = 'complete' | 'partial' | 'unknown';

/** What a rule rests on, so the page can say how well it read each one. */
export type Evidence =
  | 'calendar_tomorrow' | 'calendar_week' | 'workload' | 'meals_tomorrow' | 'meals_week'
  | 'prep_steps' | 'prep_plans' | 'bills' | 'documents' | 'trips';

export type ReadinessSignals = {
  // tomorrow
  tomorrowConflicts: number | null;
  tomorrowUnassigned: number | null;
  dinnerPlannedTomorrow: boolean;
  // this week
  conflictsWeek: number | null;
  unplannedDinnersWeek: number;
  overduePrepSteps: number;
  billsDueWeek: number;
  // this month
  expiringDocsMonth: number;
  overloadedMembers: number | null;
  upcomingTripsMonth: number;
  openPrepPlans: number;
  tomorrowCalendarCoverage?: ReadinessCoverage;
  weekCalendarCoverage?: ReadinessCoverage;
  workloadCoverage?: ReadinessCoverage;
  /**
   * How completely the remaining sources were read. The three fields above are
   * the same idea for the calendar and the roster, kept as their own names
   * because that is the shape the page and its tests already speak; anything
   * absent here defaults to `complete`, which is what a plain count means.
   */
  coverage?: Partial<Record<Evidence, ReadinessCoverage>>;
};

export const EMPTY_READINESS_SIGNALS: ReadinessSignals = {
  tomorrowConflicts: 0, tomorrowUnassigned: 0, dinnerPlannedTomorrow: true,
  conflictsWeek: 0, unplannedDinnersWeek: 0, overduePrepSteps: 0, billsDueWeek: 0,
  expiringDocsMonth: 0, overloadedMembers: 0, upcomingTripsMonth: 0, openPrepPlans: 0,
};

/** What to say when a source was read incompletely, or not at all. */
const UNKNOWN_GAP: Record<Evidence, { partial: string; unknown: string; href: string }> = {
  calendar_tomorrow: {
    partial: "Tomorrow's visible calendar is incomplete; conflict and assignment totals are unknown",
    unknown: "Tomorrow's visible calendar could not be read; conflicts and assignments are unknown",
    href: '/dashboard/calendar',
  },
  calendar_week: {
    partial: 'Weekly visible calendar is incomplete; conflict totals are unknown',
    unknown: 'Weekly visible calendar could not be read; conflict totals are unknown',
    href: '/dashboard/calendar',
  },
  workload: {
    partial: 'Workload balance is unknown: complete accessible calendar and household roster coverage is needed',
    unknown: 'Workload balance is unknown: complete accessible calendar and household roster coverage is needed',
    href: '/dashboard/family-operating-index',
  },
  meals_tomorrow: { partial: "Tomorrow's meal plan was read incompletely", unknown: "Tomorrow's meal plan could not be read", href: '/dashboard/meals' },
  meals_week: { partial: "This week's meal plan was read incompletely", unknown: "This week's meal plan could not be read", href: '/dashboard/meals' },
  prep_steps: { partial: 'Prep steps were read incompletely; overdue ones are unknown', unknown: 'Prep steps could not be read; overdue ones are unknown', href: '/dashboard/prep-plans' },
  prep_plans: { partial: 'Prep plans were read incompletely', unknown: 'Prep plans could not be read', href: '/dashboard/prep-plans' },
  bills: { partial: 'Bills were read incompletely; anything due is unknown', unknown: 'Bills could not be read; anything due is unknown', href: '/dashboard/bills' },
  documents: { partial: 'Documents were read incompletely; expiries are unknown', unknown: 'Documents could not be read; expiries are unknown', href: '/dashboard/documents' },
  trips: { partial: 'Trips were read incompletely', unknown: 'Trips could not be read', href: '/dashboard/prep-plans' },
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
  score: number;           // 0..100
  ready: ReadinessCheck[]; // what is handled
  gaps: ReadinessGap[];    // what is not, blockers first
  /** The sentence to hand Bubaly when a person presses "Let Bubaly handle it". */
  handleIt: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One readiness rule. `failing` is evaluated against what was read; `gap`
 * receives the coverage so a partial read reports a lower bound rather than a
 * total. `clear: null` means the passing state is an absence rather than an
 * accomplishment and belongs on neither list.
 */
type Rule = {
  evidence: Evidence;
  failing: boolean;
  gap: (coverage: ReadinessCoverage) => Omit<ReadinessGap, 'href'>;
  clear: string | null;
  href: string;
};

/** "At least" when we know we did not see everything. */
const bound = (coverage: ReadinessCoverage) => (coverage === 'complete' ? '' : 'At least ');

function split(
  rules: Rule[],
  coverageOf: (evidence: Evidence) => ReadinessCoverage,
): { ready: ReadinessCheck[]; gaps: ReadinessGap[] } {
  const ready: ReadinessCheck[] = [];
  const gaps: ReadinessGap[] = [];
  const incomplete = new Map<Evidence, ReadinessCoverage>();

  for (const rule of rules) {
    const coverage = coverageOf(rule.evidence);
    if (coverage !== 'complete') incomplete.set(rule.evidence, coverage);
    // Unknown: no claim in either column. What was read on a partial is still
    // worth reporting as a floor, but never as a ✓.
    if (coverage === 'unknown') continue;
    if (rule.failing) gaps.push({ ...rule.gap(coverage), href: rule.href });
    else if (coverage === 'complete' && rule.clear) ready.push({ label: rule.clear, href: rule.href });
  }

  // One line per source rather than per rule: two unknowns from the same failed
  // calendar read are one thing a person can do something about.
  for (const [evidence, coverage] of incomplete) {
    const copy = UNKNOWN_GAP[evidence];
    gaps.push({ label: coverage === 'partial' ? copy.partial : copy.unknown, href: copy.href, severity: 'watch' });
  }
  return { ready, gaps };
}

function finalize(
  horizon: Horizon,
  title: string,
  rules: Rule[],
  coverageOf: (evidence: Evidence) => ReadinessCoverage,
): ReadinessCard {
  const { ready, gaps } = split(rules, coverageOf);
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
  const explicit: Partial<Record<Evidence, ReadinessCoverage>> = {
    calendar_tomorrow: s.tomorrowCalendarCoverage
      ?? (s.tomorrowConflicts === null || s.tomorrowUnassigned === null ? 'unknown' : undefined),
    calendar_week: s.weekCalendarCoverage ?? (s.conflictsWeek === null ? 'unknown' : undefined),
    workload: s.workloadCoverage ?? (s.overloadedMembers === null ? 'unknown' : undefined),
    ...s.coverage,
  };
  const coverageOf = (evidence: Evidence): ReadinessCoverage => {
    const stated = explicit[evidence];
    if (stated) return stated;
    // The workload is worked out over the week's events; if that read was not
    // complete, the balance cannot be either, whatever the roster says.
    if (evidence === 'workload') {
      const week = explicit.calendar_week ?? 'complete';
      if (week !== 'complete') return week;
    }
    return 'complete';
  };

  const tomorrow: Rule[] = [
    {
      evidence: 'calendar_tomorrow',
      failing: (s.tomorrowConflicts ?? 0) > 0, href: '/dashboard/conflicts',
      gap: (c) => ({ label: `${bound(c)}${plural(s.tomorrowConflicts!, 'schedule clash', 'schedule clashes')} tomorrow`, severity: 'blocker' }),
      clear: 'Calendar is clear',
    },
    {
      evidence: 'calendar_tomorrow',
      failing: (s.tomorrowUnassigned ?? 0) > 0, href: '/dashboard/calendar',
      gap: (c) => ({ label: `${bound(c)}${plural(s.tomorrowUnassigned!, 'event')} with no owner`, severity: 'watch' }),
      clear: 'Everything has an owner',
    },
    {
      evidence: 'meals_tomorrow',
      failing: !s.dinnerPlannedTomorrow, href: '/dashboard/meals',
      gap: () => ({ label: "Tomorrow's dinner isn't planned", severity: 'watch' }),
      clear: "Tomorrow's dinner is planned",
    },
  ];

  const week: Rule[] = [
    {
      evidence: 'calendar_week',
      failing: (s.conflictsWeek ?? 0) > 0, href: '/dashboard/conflicts',
      gap: (c) => ({ label: `${bound(c)}${plural(s.conflictsWeek!, 'clash', 'clashes')} this week`, severity: 'blocker' }),
      clear: 'No clashes this week',
    },
    {
      evidence: 'prep_steps',
      failing: s.overduePrepSteps > 0, href: '/dashboard/prep-plans',
      gap: (c) => ({ label: `${bound(c)}${plural(s.overduePrepSteps, 'prep step')} overdue`, severity: 'blocker' }),
      clear: 'Prep is on schedule',
    },
    {
      evidence: 'meals_week',
      failing: s.unplannedDinnersWeek >= 3, href: '/dashboard/meals',
      gap: (c) => ({ label: `${bound(c)}${plural(s.unplannedDinnersWeek, 'dinner')} unplanned`, severity: 'watch' }),
      // Only a ✓ when the week is genuinely planned. Between one and two
      // unplanned dinners is neither a gap worth raising nor an achievement.
      clear: s.unplannedDinnersWeek === 0 ? 'The week of dinners is planned' : null,
    },
    {
      evidence: 'bills',
      failing: s.billsDueWeek > 0, href: '/dashboard/bills',
      gap: (c) => ({ label: `${bound(c)}${plural(s.billsDueWeek, 'bill')} due`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

  const month: Rule[] = [
    {
      evidence: 'documents',
      failing: s.expiringDocsMonth > 0, href: '/dashboard/documents',
      gap: (c) => ({ label: `${bound(c)}${plural(s.expiringDocsMonth, 'document')} expiring`, severity: 'blocker' }),
      clear: 'Documents are current',
    },
    {
      evidence: 'prep_plans',
      failing: s.openPrepPlans > 0, href: '/dashboard/prep-plans',
      gap: (c) => ({ label: `${bound(c)}${plural(s.openPrepPlans, 'prep plan')} in progress`, severity: 'watch' }),
      clear: null, // A plan in progress is work in hand, not a failure to have none.
    },
    {
      evidence: 'workload',
      failing: (s.overloadedMembers ?? 0) > 0, href: '/dashboard/family-operating-index',
      gap: () => ({ label: `${plural(s.overloadedMembers!, 'person')} carrying a heavy load in the visible calendar`, severity: 'watch' }),
      clear: 'The load is spread evenly',
    },
    {
      evidence: 'trips',
      failing: s.upcomingTripsMonth > 0, href: '/dashboard/prep-plans',
      gap: (c) => ({ label: `${bound(c)}${plural(s.upcomingTripsMonth, 'trip')} to prep`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

  return [
    finalize('tomorrow', 'Ready for tomorrow?', tomorrow, coverageOf),
    finalize('week', 'Ready for this week?', week, coverageOf),
    finalize('month', 'Ready for this month?', month, coverageOf),
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
