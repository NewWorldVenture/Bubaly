// lib/ai/weekly.ts — pure helpers for the Plus "Weekly AI Briefing".
//
// Kept free of Supabase / network so the windowing and aggregation can be unit
// tested deterministically.
//
// ── Every day here is the FAMILY's day ──────────────────────────────────────
//
// This module used to say "all dates are handled in UTC day-keys", and it meant
// it: `weekWindow` built its window from `getUTCFullYear/Month/Date` and
// `bucketByDay` took `starts_at.slice(0, 10)`. Both are the host's day wearing a
// day-key's clothes, and the briefing is where that shows worst:
//
//   * A family in Los Angeles asking for the week ahead at 6pm was told "today"
//     is tomorrow — the look-ahead started a day late and the recap ended a day
//     late, on exactly the evening somebody sits down to plan.
//   * An event at 7pm Pacific on Monday is `2026-09-15T02:00Z`, so it bucketed
//     into Tuesday. Every evening commitment in the Americas appeared on the
//     wrong day of the briefing, and for Auckland every morning one did.
//
// `tests/server-midnight-is-not-the-familys-midnight.test.ts` exists to catch
// exactly this and could not see it: it matches `setHours(0,0,0,0)`, and this is
// the same defect spelled `toISOString().slice(0,10)`. That test now looks for
// both, and this module is why.
//
// The zone arithmetic is NOT re-implemented here. `lib/services/scope.ts` owns
// it, re-resolving each local midnight rather than adding 86,400,000 ms, which
// is what keeps a 23- or 25-hour DST day from sliding the whole window.
import { addDaysToDayKey, dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';

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
 * The look-ahead (next 7 days, today inclusive) and recap (previous 7 days,
 * ending yesterday) windows around `now`, in the FAMILY's zone.
 *
 * `tz` is required rather than defaulted. A default is how this was wrong in the
 * first place: the previous version silently meant UTC, and every caller looked
 * correct.
 */
export function weekWindow(now: Date, tz: string): WeekWindow {
  const todayKey = dayKeyInTz(now, tz);
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDayKey(todayKey, i));

  // Each boundary is a real local midnight, resolved on its own day, so a DST
  // transition inside the window moves the boundary rather than the window.
  const today = zonedDayBoundsMs(todayKey, tz);
  const lastAhead = zonedDayBoundsMs(days[days.length - 1], tz);
  const firstRecap = zonedDayBoundsMs(addDaysToDayKey(todayKey, -7), tz);

  return {
    todayKey,
    aheadStart: new Date(today.start).toISOString(),
    aheadEnd: new Date(lastAhead.end - 1).toISOString(),
    recapStart: new Date(firstRecap.start).toISOString(),
    recapEnd: new Date(today.start - 1).toISOString(),
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
export function bucketByDay<T>(
  items: T[],
  getKey: (item: T) => string | null | undefined,
  days: string[],
  tz: string,
): Record<string, T[]> {
  const buckets: Record<string, T[]> = {};
  for (const d of days) buckets[d] = [];
  for (const item of items) {
    const raw = getKey(item);
    if (!raw) continue;
    // A `date` column arrives as 'YYYY-MM-DD' and is ALREADY a calendar day —
    // pushing it through a zone would shift it by one. A `timestamptz` arrives
    // as a full instant and has to be asked which local day it fell on;
    // `.slice(0, 10)` answers "which UTC day", which is the defect.
    const key = raw.length <= 10 ? raw : dayKeyInTz(new Date(raw), tz);
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
