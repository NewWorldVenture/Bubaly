// lib/school/timetable.ts — pure helpers for the weekly school timetable.
// No Supabase / React: A/B-week parity, week filtering, time parsing, and
// day-grid grouping are deterministically unit-testable.

export type WeekPattern = 'all' | 'a' | 'b';

export interface ClassLike {
  id: string;
  member_id: string;
  subject: string;
  time_slot: string | null;   // free-form, e.g. "9:00-9:50" or "9:00 AM"
  day_of_week: number | null; // 0=Sun … 6=Sat
  week_pattern: WeekPattern;
}

/**
 * Which alternating week a date falls in. Uses ISO week number parity from a
 * fixed epoch so it's stable across the year: even ISO week → 'a', odd → 'b'.
 */
export function weekParity(date: Date): 'a' | 'b' {
  // Days since Unix epoch (UTC), shifted so Monday starts the week.
  const dayMs = 86_400_000;
  const days = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / dayMs);
  // Epoch (1970-01-01) was a Thursday; align to Monday-based week index.
  const weekIndex = Math.floor((days + 3) / 7);
  return weekIndex % 2 === 0 ? 'a' : 'b';
}

/** True when a class occurs in the given week ('a' | 'b'). */
export function classOccursInWeek(c: ClassLike, week: 'a' | 'b'): boolean {
  return c.week_pattern === 'all' || c.week_pattern === week;
}

/**
 * Parses a leading time from a free-form time_slot into minutes-since-midnight
 * for sorting. Handles "9:00", "09:00", "9:00 AM", "1:30 PM", "13:30". Returns
 * a large number when unparseable so untimed classes sort last.
 */
export function slotStartMinutes(timeSlot: string | null): number {
  if (!timeSlot) return 24 * 60 + 1;
  const m = timeSlot.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return 24 * 60 + 1;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

export const WEEKDAYS = [1, 2, 3, 4, 5] as const; // Mon–Fri
export const WEEKDAY_LABELS: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

/**
 * Builds a Mon–Fri timetable for one week: each weekday maps to its classes
 * (occurring that week), sorted by start time. Classes with no day_of_week are
 * treated as daily (appear every weekday).
 */
export function buildWeekGrid(classes: ClassLike[], week: 'a' | 'b'): Record<number, ClassLike[]> {
  const grid: Record<number, ClassLike[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const occurring = classes.filter((c) => classOccursInWeek(c, week));
  for (const day of WEEKDAYS) {
    grid[day] = occurring
      .filter((c) => c.day_of_week === null || c.day_of_week === day)
      .sort((a, b) => slotStartMinutes(a.time_slot) - slotStartMinutes(b.time_slot));
  }
  return grid;
}

export const WEEK_PATTERN_LABELS: Record<WeekPattern, string> = { all: 'Every week', a: 'A weeks', b: 'B weeks' };
