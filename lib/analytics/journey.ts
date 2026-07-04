// Journey analytics — pure, unit-tested. Turns raw journey_events into the
// per-journey medians the Experience Scorecard wants (completion rate, time to
// complete, steps). Kept framework-free so it's testable without a DB.

export type JourneyPhase = 'started' | 'step' | 'completed' | 'abandoned';

/** Known journeys → human labels (extend as more flows get instrumented). */
export const JOURNEY_LABELS: Record<string, string> = {
  capture: 'Capture a thought',
  add_memory: 'Add a memory',
  voice_command: 'Voice command',
  next_actions: 'Clear next actions',
};

export function journeyLabel(key: string): string {
  return JOURNEY_LABELS[key] ?? key;
}

export type JourneyEventLike = {
  journey: string;
  phase: string;
  step: number;
  duration_ms: number | null;
  session_id: string;
  created_at: string;
};

export type JourneySummary = {
  journey: string;
  label: string;
  starts: number;
  completions: number;
  /** completions / starts, 0..1 (0 when no starts). */
  completionRate: number;
  /** Median ms across completed events that carry a duration (null if none). */
  medianDurationMs: number | null;
  /** Median step count across completed events (null if none). */
  medianSteps: number | null;
};

/** Median of a numeric list (sorted copy). Returns null for empty input. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Summarize events into one row per journey. Starts = count of 'started'
 * phases; completions = distinct sessions that reached 'completed'. Rates and
 * medians are computed from real data (no estimates).
 */
export function summarizeJourneys(events: JourneyEventLike[]): JourneySummary[] {
  const byJourney = new Map<string, JourneyEventLike[]>();
  for (const e of events) {
    const arr = byJourney.get(e.journey) ?? [];
    arr.push(e); byJourney.set(e.journey, arr);
  }

  const out: JourneySummary[] = [];
  for (const [journey, evs] of byJourney) {
    const starts = evs.filter((e) => e.phase === 'started').length;
    const completedEvents = evs.filter((e) => e.phase === 'completed');
    const completedSessions = new Set(completedEvents.map((e) => e.session_id));
    const durations = completedEvents.map((e) => e.duration_ms).filter((d): d is number => typeof d === 'number' && d >= 0);
    const steps = completedEvents.map((e) => e.step).filter((s) => typeof s === 'number');

    out.push({
      journey,
      label: journeyLabel(journey),
      starts,
      completions: completedSessions.size,
      completionRate: starts > 0 ? Math.min(1, completedSessions.size / starts) : 0,
      medianDurationMs: median(durations),
      medianSteps: median(steps),
    });
  }

  return out.sort((a, b) => b.starts - a.starts || a.journey.localeCompare(b.journey));
}

/** "3.2s" / "1m 05s" / "—" for a median duration. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** "72%" for a 0..1 rate. */
export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
