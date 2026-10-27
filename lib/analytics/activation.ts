// lib/analytics/activation.ts — TTFV / activation analytics (T10, pure + tested).
//
// The onboarding funnel (lib/analytics/onboarding.ts) measures getting THROUGH
// sign-up. This measures getting to VALUE: how long from sign-up to the first
// real outcome the family views, and what share of new families import a
// calendar / see a first briefing in their first session. TTFV is the number
// every T-item optimizes; this turns raw activation_events into it. DOM/DB-free.

import { median } from '@/lib/analytics/onboarding';
import { THIRTY_MINUTES_SEC } from '@/lib/onboarding/ttv-audit';

export type ActivationMilestone =
  | 'signup'
  | 'calendar_imported'
  | 'first_brief_viewed'
  | 'first_outcome_viewed'
  | 'first_capture';

/**
 * Ordered milestones on the path from sign-up to felt value.
 *
 * `instrumented: false` marks a milestone nothing in the product records:
 * no writer emits `first_capture` (only the seed file does), so its reach is
 * not a measured 0% and the panel says it is not recorded. `signup` has no
 * writer either; it is reached by construction once the cohorts are the
 * households themselves (summarizeActivation's `cohorts`).
 */
export const ACTIVATION_MILESTONES: { key: ActivationMilestone; label: string; instrumented?: false }[] = [
  { key: 'signup', label: 'Signed up' },
  { key: 'calendar_imported', label: 'Imported a calendar' },
  { key: 'first_brief_viewed', label: 'Saw first briefing' },
  { key: 'first_outcome_viewed', label: 'Viewed first outcome' },
  { key: 'first_capture', label: 'First capture', instrumented: false },
];

/** "First value" — the milestone TTFV is measured to. */
export const FIRST_VALUE_MILESTONE: ActivationMilestone = 'first_outcome_viewed';

const DAY_MS = 86_400_000;

/** Derive a session ordinal from time-since-signup, so "session 1" is consistent
 *  whether the event is recorded on the client or server: within a day of sign-up
 *  = session 1, within a week = session 2, later = session 3+. */
export function sessionIndexFromMs(msSinceSignup: number | null | undefined): number {
  if (typeof msSinceSignup !== 'number' || msSinceSignup < DAY_MS) return 1;
  if (msSinceSignup < 7 * DAY_MS) return 2;
  return 3;
}

/** The largest value `activation_events.ms_since_signup` (an INTEGER, 0146) holds: about 24.8 days. */
export const MAX_RECORDED_SIGNUP_MS = 2_147_483_647;

/**
 * The TTFV clock as the column can store it. A household older than ~24.8
 * days does not fit, and PostgREST refused the whole insert (22003), so a
 * member who joined a settled household — or anyone who first opened Outcomes
 * after that — was never recorded at all. Such a milestone is recorded
 * untimed instead; `sessionIndexFromMs` still takes the real elapsed time.
 */
export function recordableMsSinceSignup(msSinceSignup: number | null): number | null {
  return typeof msSinceSignup === 'number' && Number.isFinite(msSinceSignup) && msSinceSignup >= 0 && msSinceSignup <= MAX_RECORDED_SIGNUP_MS
    ? Math.round(msSinceSignup)
    : null;
}

export type ActivationEventLike = {
  session_id: string;              // cohort key — one per new family / onboarding run
  milestone: string;
  session_index: number;           // 1 = first session
  ms_since_signup: number | null;  // TTFV clock
  created_at: string;
};

export type MilestoneReach = { key: ActivationMilestone; label: string; cohorts: number; rate: number; instrumented: boolean };

export type ActivationSummary = {
  cohorts: number;                 // distinct new-family runs seen
  activatedCohorts: number;        // reached first value
  activationRate: number;          // activatedCohorts / cohorts, 0..1
  ttfvMedianMs: number | null;     // median sign-up → first outcome viewed
  ttfvP90Ms: number | null;        // 90th percentile (the slow tail)
  timedValueCohorts: number;
  untimedValueCohorts: number;
  under30MinCohorts: number;
  under30MinRate: number | null;  // 0..1 among cohorts with valid first-value timing
  session1: {
    calendarImportRate: number;    // share of cohorts importing a calendar in session 1
    firstBriefRate: number;        // share seeing a first briefing in session 1
    firstOutcomeRate: number;      // share viewing a first outcome in session 1
  };
  milestoneReach: MilestoneReach[];
};

/** p-th percentile (0..1) using nearest-rank. */
export function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

/**
 * Roll raw activation events up into the TTFV scorecard. Cohorts are keyed by
 * session_id (one new family / run). TTFV per cohort is the *earliest* time it
 * reached first value; the summary reports the median + p90 across cohorts.
 *
 * `cohorts`, when given, IS the cohort set — every household created in the
 * window — and an event outside it counts for nothing. Without it the cohorts
 * are the session_ids the events happen to carry, which only ever includes a
 * household that already reached a recorded milestone.
 */
export function summarizeActivation(events: ActivationEventLike[], options: { cohorts?: Iterable<string> } = {}): ActivationSummary {
  const known = options.cohorts ? new Set(options.cohorts) : null;
  const cohortSet = new Set<string>(known ?? []);
  const reachByMilestone = new Map<string, Set<string>>();
  const session1ByMilestone = new Map<string, Set<string>>();
  const ttfvByCohort = new Map<string, number>();

  const add = (m: Map<string, Set<string>>, key: string, cohort: string) => {
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(cohort);
  };
  // Every household in a supplied cohort set signed up; nothing writes the row.
  if (known) for (const cohort of known) add(reachByMilestone, 'signup', cohort);

  for (const e of events) {
    if (known && !known.has(e.session_id)) continue;
    cohortSet.add(e.session_id);
    add(reachByMilestone, e.milestone, e.session_id);
    if (e.session_index <= 1) add(session1ByMilestone, e.milestone, e.session_id);
    if (e.milestone === FIRST_VALUE_MILESTONE && typeof e.ms_since_signup === 'number' && Number.isFinite(e.ms_since_signup) && e.ms_since_signup >= 0) {
      const prev = ttfvByCohort.get(e.session_id);
      if (prev === undefined || e.ms_since_signup < prev) ttfvByCohort.set(e.session_id, e.ms_since_signup);
    }
  }

  const cohorts = cohortSet.size;
  const rate = (n: number) => (cohorts > 0 ? n / cohorts : 0);
  const activated = reachByMilestone.get(FIRST_VALUE_MILESTONE)?.size ?? 0;
  const ttfvs = [...ttfvByCohort.values()];
  const under30MinCohorts = ttfvs.filter((ms) => ms <= THIRTY_MINUTES_SEC * 1000).length;

  const milestoneReach: MilestoneReach[] = ACTIVATION_MILESTONES.map((m) => {
    const c = reachByMilestone.get(m.key)?.size ?? 0;
    return { key: m.key, label: m.label, cohorts: c, rate: rate(c), instrumented: m.instrumented !== false };
  });

  return {
    cohorts,
    activatedCohorts: activated,
    activationRate: rate(activated),
    ttfvMedianMs: median(ttfvs),
    ttfvP90Ms: percentile(ttfvs, 0.9),
    timedValueCohorts: ttfvs.length,
    untimedValueCohorts: activated - ttfvs.length,
    under30MinCohorts,
    under30MinRate: ttfvs.length ? under30MinCohorts / ttfvs.length : null,
    session1: {
      calendarImportRate: rate(session1ByMilestone.get('calendar_imported')?.size ?? 0),
      firstBriefRate: rate(session1ByMilestone.get('first_brief_viewed')?.size ?? 0),
      firstOutcomeRate: rate(session1ByMilestone.get('first_outcome_viewed')?.size ?? 0),
    },
    milestoneReach,
  };
}
