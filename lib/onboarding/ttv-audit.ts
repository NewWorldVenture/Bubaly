// lib/onboarding/ttv-audit.ts — the onboarding time-to-value audit (pure,
// unit-tested). Reads onboarding_progress rows and measures the first-run
// funnel: how far people get (step completion), how many activate, how fast
// they reach value (TTV median / p90 / % under the 90-second goal), and where
// the incomplete ones stall. No browser/DB deps — the admin page is a thin
// renderer over this.

export const ONBOARDING_STEPS = [
  { key: 'profile', label: 'Profile' },
  { key: 'family', label: 'Family' },
  { key: 'value', label: 'First value' },
  { key: 'about', label: 'About' },
  { key: 'members', label: 'Members' },
  { key: 'pin', label: 'PIN' },
] as const;

export type StepKey = (typeof ONBOARDING_STEPS)[number]['key'];

export const TTV_GOAL_SEC = 90;
export const THIRTY_MINUTES_SEC = 30 * 60;

export type OnboardingRow = {
  created_at: string;
  completed_at: string | null;
  status: string;
  value_engaged: boolean;
  steps_completed: string[] | null;
};

export type StepStat = { key: StepKey; label: string; count: number; pct: number };
export type StallStat = { key: StepKey | 'not_started'; label: string; count: number };

export type OnboardingAudit = {
  total: number;
  completed: number;
  completionRate: number;      // 0..100
  valueEngagedRate: number;    // 0..100
  medianTtvSec: number | null;
  p90TtvSec: number | null;
  under90Rate: number | null;  // 0..100, share of timed setups completed within goal
  timedCompletions: number;
  untimedCompletions: number;
  under30MinCount: number;
  under30MinRate: number | null; // 0..100 among completions with valid timestamps
  stepFunnel: StepStat[];
  stalls: StallStat[];         // where incomplete runs stopped (most common first)
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Completion seconds for a finished run (null if unfinished or unparseable). */
export function ttvSeconds(row: OnboardingRow): number | null {
  if (!row.completed_at) return null;
  const start = new Date(row.created_at).getTime();
  const end = new Date(row.completed_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

/** Nearest-rank percentile of a numeric list (returns null when empty). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const isCompleted = (r: OnboardingRow) => r.status === 'completed' || !!r.completed_at;

/** The furthest step a run reached, in canonical order (null if none). */
export function furthestStep(steps: string[] | null): StepKey | null {
  const done = new Set(steps ?? []);
  let last: StepKey | null = null;
  for (const s of ONBOARDING_STEPS) if (done.has(s.key)) last = s.key;
  return last;
}

export function analyzeOnboarding(rows: OnboardingRow[]): OnboardingAudit {
  const total = rows.length;
  const completedRows = rows.filter(isCompleted);
  const completed = completedRows.length;

  const ttvs = completedRows.map(ttvSeconds).filter((n): n is number => n != null);
  const under90 = ttvs.filter((s) => s <= TTV_GOAL_SEC).length;
  const under30MinCount = ttvs.filter((s) => s <= THIRTY_MINUTES_SEC).length;

  const stepFunnel: StepStat[] = ONBOARDING_STEPS.map((s) => {
    const count = rows.filter((r) => (r.steps_completed ?? []).includes(s.key)).length;
    return { key: s.key, label: s.label, count, pct: total ? round1((count / total) * 100) : 0 };
  });

  // Where incomplete runs stopped.
  const stallCounts = new Map<StepKey | 'not_started', number>();
  for (const r of rows) {
    if (isCompleted(r)) continue;
    const key = furthestStep(r.steps_completed) ?? 'not_started';
    stallCounts.set(key, (stallCounts.get(key) ?? 0) + 1);
  }
  const stepLabel = (k: StepKey | 'not_started') =>
    k === 'not_started' ? 'Never started' : ONBOARDING_STEPS.find((s) => s.key === k)!.label;
  const stalls: StallStat[] = [...stallCounts.entries()]
    .map(([key, count]) => ({ key, label: stepLabel(key), count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    completed,
    completionRate: total ? round1((completed / total) * 100) : 0,
    valueEngagedRate: total ? round1((rows.filter((r) => r.value_engaged).length / total) * 100) : 0,
    medianTtvSec: percentile(ttvs, 50),
    p90TtvSec: percentile(ttvs, 90),
    under90Rate: ttvs.length ? round1((under90 / ttvs.length) * 100) : null,
    timedCompletions: ttvs.length,
    untimedCompletions: completed - ttvs.length,
    under30MinCount,
    under30MinRate: ttvs.length ? round1((under30MinCount / ttvs.length) * 100) : null,
    stepFunnel,
    stalls,
  };
}

/** Seconds → compact "1m 12s" / "48s". */
export function formatDuration(sec: number | null): string {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
