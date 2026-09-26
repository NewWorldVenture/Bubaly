// lib/ai/weekly.ts — pure helpers for the Plus "Weekly AI Briefing".
//
// Kept free of Supabase / network so the windowing and aggregation can be unit
// tested deterministically.
//
// THE WEEK IS THE FAMILY'S WEEK, and this file used to say the opposite. Its
// header read:
//
//     All dates are handled in UTC day-keys (YYYY-MM-DD), matching the
//     convention used by the daily-briefing route.
//
// That was true when it was written, on 2026-07-18. It stopped being true on
// 2026-09-06, when `7ef10c59` — "fix(briefing): the Daily Brief arrives, in the
// family's own morning" — moved the daily route to `dayKeyInTz(now, tz)` and left
// this comment pointing at the fix as though it were the precedent for the bug.
// The daily route's own note says what it cost: "for a family in Los Angeles at
// 5pm it is already tomorrow, so the brief covered the wrong day". The weekly
// briefing was simply not carried across.
//
// Concretely, in UTC day-keys, for a family in America/Los_Angeles: a 21:00
// Saturday game is 04:00 Sunday at Greenwich, so it appeared under SUNDAY in the
// week grid, and the week itself ran 17:00 Sunday to 17:00 Sunday rather than
// midnight to midnight.
//
// `lib/schedule/zoned.ts` is used rather than `lib/services/scope.ts` on purpose:
// scope.ts opens with `import 'server-only'`, and this module's whole point is
// that it can be exercised in a unit test. zoned.ts states that it keeps the
// identical day-key shape, so a key from here compares equal to one from there.
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

const MS_DAY = 24 * 60 * 60 * 1000;

/**
 * ISO YYYY-MM-DD for a Date, at Greenwich.
 *
 * Still exported because it is still the right answer for a value that IS a UTC
 * instant and is not being presented to a family as a day. It is no longer what
 * the week grid is built from.
 */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The day after a day KEY, by calendar arithmetic. */
function nextDayKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The instant a family's calendar day begins.
 *
 * Advancing a day KEY and asking when that day starts, rather than adding
 * `86_400_000` to an instant, is what makes the window survive a DST boundary:
 * the local day is 23 or 25 hours long twice a year, and a fixed-millisecond
 * step either skips a day or repeats one.
 */
function startOfDayMs(key: string, tz: string): number {
  return zonedTimeMs(key, 0, 0, tz);
}

export type WeekWindow = {
  /** Today's day-key, in the family's zone. */
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
export function weekWindow(now: Date, tz: string): WeekWindow {
  // `tz` is REQUIRED rather than defaulted to 'UTC'. A default is what let this
  // module be wrong quietly for seven weeks: the one caller would have kept
  // compiling and kept shipping Greenwich weeks. There is one caller, so making
  // it required costs one line and removes the failure mode.
  const todayKey = dayKeyInZone(now.getTime(), tz) ?? dayKey(now);

  const days: string[] = [todayKey];
  for (let i = 1; i < 7; i += 1) days.push(nextDayKey(days[i - 1]));

  // Each boundary is the start of a family day, so every window edge lands on
  // their midnight rather than Greenwich's.
  const aheadStart = startOfDayMs(todayKey, tz);
  const aheadEnd = startOfDayMs(nextDayKey(days[6]), tz) - 1;

  let recapKey = todayKey;
  for (let i = 0; i < 7; i += 1) recapKey = previousDayKey(recapKey);
  const recapStart = startOfDayMs(recapKey, tz);
  const recapEnd = aheadStart - 1; // end of yesterday, their time

  return {
    todayKey,
    aheadStart: new Date(aheadStart).toISOString(),
    aheadEnd: new Date(aheadEnd).toISOString(),
    recapStart: new Date(recapStart).toISOString(),
    recapEnd: new Date(recapEnd).toISOString(),
    days,
  };
}

/** The day before a day KEY, by calendar arithmetic. See `nextDayKey`. */
function previousDayKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
    // `raw.slice(0, 10)` is the day at GREENWICH. That is the defect, and it is
    // the one the repo's existing guard cannot see, because
    // tests/family-day-not-greenwich-day.test.ts scans for a literal
    // `.toISOString()` before the slice and a column read has none.
    const parsed = Date.parse(raw);
    const key = Number.isNaN(parsed) ? raw.slice(0, 10) : dayKeyInZone(parsed, tz) ?? raw.slice(0, 10);
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
