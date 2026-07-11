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
