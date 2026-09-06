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
// AND A ✓ IS A CLAIM, SO IT NEEDS EVIDENCE. Every signal here arrives from a
// best-effort read that returns 0 when it fails, which was harmless while the
// card only listed gaps — nothing to report reads the same as nothing wrong.
// The moment a zero became "Calendar is clear" it stopped being harmless: a
// failed query would tell a family their week was handled. Each rule therefore
// names the `evidence` it rests on, the page says which evidence it actually
// got, and a rule whose evidence is missing makes no claim in either column —
// the horizon says the check could not be run instead.

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
  /**
   * Evidence the page could not obtain — a failed read, or one it knows was
   * truncated. Absent means everything was read, which is what every existing
   * caller and fixture means.
   */
  unavailable?: readonly Evidence[];
};

export const EMPTY_READINESS_SIGNALS: ReadinessSignals = {
  tomorrowConflicts: 0, tomorrowUnassigned: 0, dinnerPlannedTomorrow: true,
  conflictsWeek: 0, unplannedDinnersWeek: 0, overduePrepSteps: 0, billsDueWeek: 0,
  expiringDocsMonth: 0, overloadedMembers: 0, upcomingTripsMonth: 0, openPrepPlans: 0,
};

/**
 * What a rule rests on. The page reports which of these it could not read, and
 * a rule with missing evidence is silent rather than reassuring.
 */
export type Evidence =
  | 'calendar_tomorrow' | 'calendar_week' | 'workload' | 'meals_tomorrow' | 'meals_week'
  | 'prep_steps' | 'prep_plans' | 'bills' | 'documents' | 'trips';

/** What to say when a check could not be run at all. */
const UNKNOWN_LABEL: Record<Evidence, { label: string; href: string }> = {
  calendar_tomorrow: { label: "Tomorrow's calendar could not be read, so clashes and owners are unknown", href: '/dashboard/calendar' },
  calendar_week: { label: "This week's calendar could not be read, so clashes are unknown", href: '/dashboard/calendar' },
  workload: { label: 'Who is carrying what could not be worked out from the calendar and the roster', href: '/dashboard/family-operating-index' },
  meals_tomorrow: { label: "Tomorrow's meal plan could not be read", href: '/dashboard/meals' },
  meals_week: { label: "This week's meal plan could not be read", href: '/dashboard/meals' },
  prep_steps: { label: 'Prep steps could not be read, so overdue ones are unknown', href: '/dashboard/prep-plans' },
  prep_plans: { label: 'Prep plans could not be read', href: '/dashboard/prep-plans' },
  bills: { label: 'Bills could not be read, so anything due is unknown', href: '/dashboard/bills' },
  documents: { label: 'Documents could not be read, so expiries are unknown', href: '/dashboard/documents' },
  trips: { label: 'Trips could not be read', href: '/dashboard/prep-plans' },
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
  evidence: Evidence;
  failing: boolean;
  gap: () => Omit<ReadinessGap, 'href'>;
  clear: string | null;
  href: string;
};

function split(rules: Rule[], unavailable: ReadonlySet<Evidence>): { ready: ReadinessCheck[]; gaps: ReadinessGap[] } {
  const ready: ReadinessCheck[] = [];
  const gaps: ReadinessGap[] = [];
  const missing = new Set<Evidence>();
  for (const rule of rules) {
    // Silent, not reassuring: a rule whose evidence never arrived makes no
    // claim in either column.
    if (unavailable.has(rule.evidence)) { missing.add(rule.evidence); continue; }
    if (rule.failing) gaps.push({ ...rule.gap(), href: rule.href });
    else if (rule.clear) ready.push({ label: rule.clear, href: rule.href });
  }
  // One line per missing source rather than per rule: two unknowns from the
  // same failed calendar read are one thing a person can do something about.
  for (const evidence of missing) {
    const { label, href } = UNKNOWN_LABEL[evidence];
    gaps.push({ label, href, severity: 'watch' });
  }
  return { ready, gaps };
}

function finalize(horizon: Horizon, title: string, rules: Rule[], unavailable: ReadonlySet<Evidence>): ReadinessCard {
  const { ready, gaps } = split(rules, unavailable);
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
  const unavailable = new Set<Evidence>(s.unavailable ?? []);
  // The workload answer needs both the week's events and the roster; if either
  // is missing it cannot be worked out, whatever the other one says.
  if (unavailable.has('calendar_week')) unavailable.add('workload');
  const tomorrow: Rule[] = [
    {
      evidence: 'calendar_tomorrow',
      failing: s.tomorrowConflicts > 0, href: '/dashboard/conflicts',
      gap: () => ({ label: `${plural(s.tomorrowConflicts, 'schedule clash', 'schedule clashes')} tomorrow`, severity: 'blocker' }),
      clear: 'Calendar is clear',
    },
    {
      evidence: 'calendar_tomorrow',
      failing: s.tomorrowUnassigned > 0, href: '/dashboard/calendar',
      gap: () => ({ label: `${plural(s.tomorrowUnassigned, 'event')} with no owner`, severity: 'watch' }),
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
      failing: s.conflictsWeek > 0, href: '/dashboard/conflicts',
      gap: () => ({ label: `${plural(s.conflictsWeek, 'clash', 'clashes')} this week`, severity: 'blocker' }),
      clear: 'No clashes this week',
    },
    {
      evidence: 'prep_steps',
      failing: s.overduePrepSteps > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.overduePrepSteps, 'prep step')} overdue`, severity: 'blocker' }),
      clear: 'Prep is on schedule',
    },
    {
      evidence: 'meals_week',
      failing: s.unplannedDinnersWeek >= 3, href: '/dashboard/meals',
      gap: () => ({ label: `${plural(s.unplannedDinnersWeek, 'dinner')} unplanned`, severity: 'watch' }),
      // Only a ✓ when the week is genuinely planned. Between one and two
      // unplanned dinners is neither a gap worth raising nor an achievement.
      clear: s.unplannedDinnersWeek === 0 ? 'The week of dinners is planned' : null,
    },
    {
      evidence: 'bills',
      failing: s.billsDueWeek > 0, href: '/dashboard/bills',
      gap: () => ({ label: `${plural(s.billsDueWeek, 'bill')} due`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

  const month: Rule[] = [
    {
      evidence: 'documents',
      failing: s.expiringDocsMonth > 0, href: '/dashboard/documents',
      gap: () => ({ label: `${plural(s.expiringDocsMonth, 'document')} expiring`, severity: 'blocker' }),
      clear: 'Documents are current',
    },
    {
      evidence: 'prep_plans',
      failing: s.openPrepPlans > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.openPrepPlans, 'prep plan')} in progress`, severity: 'watch' }),
      clear: null, // A plan in progress is work in hand, not a failure to have none.
    },
    {
      evidence: 'workload',
      failing: s.overloadedMembers > 0, href: '/dashboard/family-operating-index',
      gap: () => ({ label: `${plural(s.overloadedMembers, 'person')} carrying a heavy load`, severity: 'watch' }),
      clear: 'The load is spread evenly',
    },
    {
      evidence: 'trips',
      failing: s.upcomingTripsMonth > 0, href: '/dashboard/prep-plans',
      gap: () => ({ label: `${plural(s.upcomingTripsMonth, 'trip')} to prep`, severity: 'watch' }),
      clear: null, // An absence, not an accomplishment.
    },
  ];

  return [
    finalize('tomorrow', 'Ready for tomorrow?', tomorrow, unavailable),
    finalize('week', 'Ready for this week?', week, unavailable),
    finalize('month', 'Ready for this month?', month, unavailable),
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
