// Onboarding funnel analytics — pure, unit-tested. Turns raw onboarding_events
// into a step-by-step funnel: how many sessions reached each step, the drop-off
// between steps, overall completion rate, and median time to complete. Framework-
// free so it's testable without a DB. (Companion to lib/analytics/journey.ts,
// which needs a family_id this pre-family flow doesn't have yet.)

export type OnboardingPhase = 'started' | 'step' | 'completed' | 'abandoned';

/** The canonical onboarding steps, in order (extend as the wizard changes). */
export const ONBOARDING_STEPS: { key: string; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'family', label: 'Family name' },
  { key: 'value', label: 'See your week (calendar)' },
  { key: 'about', label: 'About your family' },
  { key: 'members', label: 'Add members' },
  { key: 'pin', label: 'App lock (PIN)' },
  { key: 'done', label: 'Done' },
];

export type OnboardingEventLike = {
  session_id: string;
  step: string;
  phase: string;
  duration_ms: number | null;
  created_at: string;
};

export type FunnelStep = {
  key: string;
  label: string;
  /** Distinct sessions that reached this step. */
  reached: number;
  /** reached / firstStepReached, 0..1. */
  reachRate: number;
  /** Sessions lost between the previous step and this one. */
  droppedFromPrev: number;
};

export type OnboardingFunnel = {
  steps: FunnelStep[];
  startedSessions: number;
  completedSessions: number;
  completionRate: number;      // completed / started, 0..1
  medianCompletionMs: number | null;
  /** Step key with the biggest drop-off (null when nothing to report). */
  biggestDropStep: string | null;
};

/** An onboarding event as the admin funnel reads it: with the account that filed it. */
export type AccountOnboardingEvent = OnboardingEventLike & { user_id: string | null };

/**
 * One wizard run per account: the funnel counts people, not session ids.
 *
 * 0133 lets a signed-in account file any number of rows under its own
 * user_id, each with any session_id and any duration, and the funnel keys runs
 * by session — so one free signup inserting {session_id: 'x'+i, step: 'done',
 * phase: 'completed'} in a loop moved Sessions started, Completed, the
 * completion rate, the median time and the biggest drop. Each account now
 * contributes one session: the earliest it finished, otherwise the earliest it
 * started, otherwise its earliest. A real person's second tab is the same
 * person. Rows that name no account are not a run (the loader already
 * refuses them; this does not rely on it).
 */
export function oneRunPerAccount<T extends AccountOnboardingEvent>(
  events: T[],
  steps: { key: string; label: string }[] = ONBOARDING_STEPS,
): T[] {
  const terminalKey = steps[steps.length - 1]?.key;
  type Run = { session: string; firstAt: number; started: boolean; finished: boolean };
  const runs = new Map<string, Map<string, Run>>();
  for (const e of events) {
    if (typeof e.user_id !== 'string' || !e.user_id) continue;
    const at = Date.parse(e.created_at);
    const byUser = runs.get(e.user_id) ?? new Map<string, Run>();
    runs.set(e.user_id, byUser);
    const run = byUser.get(e.session_id) ?? { session: e.session_id, firstAt: Number.POSITIVE_INFINITY, started: false, finished: false };
    byUser.set(e.session_id, run);
    if (Number.isFinite(at) && at < run.firstAt) run.firstAt = at;
    if (e.phase === 'started') run.started = true;
    if (e.phase === 'completed' || (terminalKey !== undefined && e.step === terminalKey)) run.finished = true;
  }
  const kept = new Map<string, string>();
  for (const [user, byUser] of runs) {
    const [chosen] = [...byUser.values()].sort((a, b) =>
      Number(b.finished) - Number(a.finished) || Number(b.started) - Number(a.started)
      || a.firstAt - b.firstAt || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    if (chosen) kept.set(user, chosen.session);
  }
  // Keyed by the account from here on: a session id is the writer's free text,
  // and one account naming another's session id must not merge into that run.
  return events
    .filter((e) => typeof e.user_id === 'string' && kept.get(e.user_id) === e.session_id)
    .map((e) => ({ ...e, session_id: e.user_id as string }));
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Build the funnel. `reached` counts DISTINCT sessions that logged any event for
 * a step; completion = sessions that reached the terminal step OR logged a
 * 'completed' phase. Rates are relative to the first step's reach (so a partial
 * data window doesn't distort them).
 */
export function summarizeOnboardingFunnel(
  events: OnboardingEventLike[],
  steps: { key: string; label: string }[] = ONBOARDING_STEPS,
): OnboardingFunnel {
  const sessionsByStep = new Map<string, Set<string>>();
  const startedSessions = new Set<string>();
  const completedSessions = new Set<string>();
  const completionMsBySession = new Map<string, number>();

  for (const e of events) {
    if (!sessionsByStep.has(e.step)) sessionsByStep.set(e.step, new Set());
    sessionsByStep.get(e.step)!.add(e.session_id);
    if (e.phase === 'started') startedSessions.add(e.session_id);
    if (e.phase === 'completed') {
      completedSessions.add(e.session_id);
      if (typeof e.duration_ms === 'number') {
        // keep the largest duration seen for a session's completion
        const prev = completionMsBySession.get(e.session_id) ?? 0;
        if (e.duration_ms > prev) completionMsBySession.set(e.session_id, e.duration_ms);
      }
    }
  }

  const terminalKey = steps[steps.length - 1]?.key;
  if (terminalKey) for (const s of sessionsByStep.get(terminalKey) ?? []) completedSessions.add(s);

  const firstReached = steps.length ? (sessionsByStep.get(steps[0].key)?.size ?? 0) : 0;
  const base = firstReached || startedSessions.size || 1;

  const funnelSteps: FunnelStep[] = [];
  let prevReached = base;
  for (const st of steps) {
    const reached = sessionsByStep.get(st.key)?.size ?? 0;
    funnelSteps.push({
      key: st.key, label: st.label, reached,
      reachRate: reached / base,
      droppedFromPrev: Math.max(0, prevReached - reached),
    });
    prevReached = reached;
  }

  const started = startedSessions.size || firstReached;
  const completed = completedSessions.size;

  // Biggest drop-off step (skip the first — nothing precedes it).
  let biggestDropStep: string | null = null;
  let biggestDrop = 0;
  for (let i = 1; i < funnelSteps.length; i++) {
    if (funnelSteps[i].droppedFromPrev > biggestDrop) {
      biggestDrop = funnelSteps[i].droppedFromPrev;
      biggestDropStep = funnelSteps[i].key;
    }
  }

  return {
    steps: funnelSteps,
    startedSessions: started,
    completedSessions: completed,
    completionRate: started > 0 ? completed / started : 0,
    medianCompletionMs: median([...completionMsBySession.values()]),
    biggestDropStep,
  };
}

export function formatRate(r: number): string {
  return `${Math.round(r * 100)}%`;
}
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
