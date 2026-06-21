// lib/ai/weekly.ts — pure helpers for the Plus "Weekly AI Briefing".
//
// Kept free of Supabase / network so the windowing and aggregation can be unit
// tested deterministically. All dates are handled in UTC day-keys (YYYY-MM-DD),
// matching the convention used by the daily-briefing route.

const MS_DAY = 24 * 60 * 60 * 1000;

/** ISO YYYY-MM-DD for a Date (UTC). */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type WeekWindow = {
  /** Today's day-key (UTC). */
  todayKey: string;
  /** Start of today (inclusive) — ISO. */
  aheadStart: string;
  /** End of the 7-day look-ahead window (today .. +6), inclusive — ISO. */
  aheadEnd: string;
  /** Start of the 7-day recap window (yesterday .. -7), inclusive — ISO. */
  recapStart: string;
  /** End of the recap window (end of yesterday), inclusive — ISO. */
  recapEnd: string;
  /** The seven upcoming day-keys, today first. */
  days: string[];
};

/**
 * Computes the look-ahead (next 7 days, today inclusive) and recap (previous 7
 * days, ending yesterday) windows around `now`.
 */
export function weekWindow(now: Date): WeekWindow {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const aheadStart = startOfToday;
  const aheadEnd = new Date(startOfToday.getTime() + 7 * MS_DAY - 1); // end of today+6
  const recapStart = new Date(startOfToday.getTime() - 7 * MS_DAY);
  const recapEnd = new Date(startOfToday.getTime() - 1); // end of yesterday

  const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(startOfToday.getTime() + i * MS_DAY)));

  return {
    todayKey: dayKey(startOfToday),
    aheadStart: aheadStart.toISOString(),
    aheadEnd: aheadEnd.toISOString(),
    recapStart: recapStart.toISOString(),
    recapEnd: recapEnd.toISOString(),
    days,
  };
}

/** Statuses that count as a completed chore assignment. */
const DONE_STATUSES = new Set(['done', 'approved', 'completed']);

/**
 * Percentage (0–100, rounded) of chore assignments that reached a completed
 * state. Returns 0 for an empty set (nothing scheduled => nothing missed).
 */
export function choreCompletionRate(assignments: { status: string }[]): number {
  if (assignments.length === 0) return 0;
  const done = assignments.filter((a) => DONE_STATUSES.has(a.status)).length;
  return Math.round((done / assignments.length) * 100);
}

/**
 * Buckets items into the provided day-keys by a date accessor. Items whose key
 * falls outside `days` are dropped. Every day in `days` is present in the result
 * (empty array when nothing lands there), so callers can render a full week.
 */
export function bucketByDay<T>(items: T[], getKey: (item: T) => string | null | undefined, days: string[]): Record<string, T[]> {
  const buckets: Record<string, T[]> = {};
  for (const d of days) buckets[d] = [];
  for (const item of items) {
    const raw = getKey(item);
    if (!raw) continue;
    const key = raw.slice(0, 10);
    if (key in buckets) buckets[key].push(item);
  }
  return buckets;
}

/** A coarse "how busy is this day" label from an event count. */
export function dayLoad(eventCount: number): 'light' | 'moderate' | 'heavy' {
  if (eventCount >= 5) return 'heavy';
  if (eventCount >= 2) return 'moderate';
  return 'light';
}

/** Human label like "Jun 20 – Jun 26" for the look-ahead window. */
export function weekRangeLabel(window: WeekWindow): string {
  const fmt = (key: string) =>
    new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(window.days[0])} – ${fmt(window.days[window.days.length - 1])}`;
}
