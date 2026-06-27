// lib/habits/streaks.ts — pure, testable habit math.
// No I/O: takes plain log dates + a habit cadence and computes streaks,
// completion rates, and the heatmap cells the UI renders. Keeping this pure
// means the streak logic (the part users obsess over) is fully unit-tested.

export type Cadence = 'daily' | 'weekly';

/** A minimal habit shape the math needs — the full row is a superset. */
export type HabitLike = {
  cadence: Cadence;
  target_per_period: number;
  weekdays?: number[] | null; // 0..6 Sun..Sat; empty/absent = every day (daily only)
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO date (YYYY-MM-DD) in UTC for a Date. */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD string to a UTC Date at midnight. */
export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/** Add (possibly negative) days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  return toISODate(new Date(fromISODate(iso).getTime() + days * DAY_MS));
}

/** Difference in whole days between two ISO dates (a - b). */
export function daysBetween(a: string, b: string): number {
  return Math.round((fromISODate(a).getTime() - fromISODate(b).getTime()) / DAY_MS);
}

/** Set of unique log dates (dedupes multiple logs per day). */
function dateSet(logDates: string[]): Set<string> {
  return new Set(logDates.map((d) => d.slice(0, 10)));
}

/** Is the daily habit scheduled on this date? (weekday filter; empty = every day) */
export function isScheduledOn(habit: HabitLike, iso: string): boolean {
  if (habit.cadence !== 'daily') return true;
  const wds = habit.weekdays ?? [];
  if (wds.length === 0) return true;
  return wds.includes(fromISODate(iso).getUTCDay());
}

/**
 * Current streak: count of consecutive scheduled days completed, ending today
 * (or yesterday — today not yet logged shouldn't break a streak). For weekly
 * habits a "unit" is an ISO week meeting target_per_period completions.
 */
export function currentStreak(habit: HabitLike, logDates: string[], today: string): number {
  const done = dateSet(logDates);
  if (habit.cadence === 'weekly') {
    return currentWeeklyStreak(habit, done, today);
  }
  let streak = 0;
  let cursor = today;
  // Allow today to be unlogged without breaking the streak.
  if (!done.has(today) && isScheduledOn(habit, today)) cursor = addDays(today, -1);
  // Walk backwards over scheduled days only.
  for (let guard = 0; guard < 3650; guard++) {
    if (!isScheduledOn(habit, cursor)) {
      cursor = addDays(cursor, -1);
      continue;
    }
    if (done.has(cursor)) {
      streak++;
      cursor = addDays(cursor, -1);
    } else {
      break;
    }
  }
  return streak;
}

/** Longest run of consecutive scheduled completed days in the history. */
export function longestStreak(habit: HabitLike, logDates: string[]): number {
  const done = Array.from(dateSet(logDates)).sort();
  if (done.length === 0) return 0;
  if (habit.cadence === 'weekly') {
    // For weekly, approximate longest as max consecutive ISO weeks hit.
    return longestWeeklyStreak(habit, new Set(done));
  }
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of done) {
    if (prev === null) {
      run = 1;
    } else {
      // count scheduled gap days between prev and day
      let expected = addDays(prev, 1);
      while (!isScheduledOn(habit, expected) && expected < day) expected = addDays(expected, 1);
      run = expected === day ? run + 1 : 1;
    }
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

function isoWeekKey(iso: string): string {
  // ISO week number (1..53) with year, e.g. "2026-W12".
  const d = fromISODate(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weeklyCounts(done: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const day of done) {
    const k = isoWeekKey(day);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function currentWeeklyStreak(habit: HabitLike, done: Set<string>, today: string): number {
  const counts = weeklyCounts(done);
  const target = Math.max(1, habit.target_per_period);
  let streak = 0;
  let cursor = today;
  // current week counts only if it has already met target; otherwise start from last week
  if ((counts.get(isoWeekKey(cursor)) ?? 0) < target) cursor = addDays(cursor, -7);
  for (let guard = 0; guard < 520; guard++) {
    if ((counts.get(isoWeekKey(cursor)) ?? 0) >= target) {
      streak++;
      cursor = addDays(cursor, -7);
    } else break;
  }
  return streak;
}

function longestWeeklyStreak(habit: HabitLike, done: Set<string>): number {
  const counts = weeklyCounts(done);
  const target = Math.max(1, habit.target_per_period);
  const weeks = Array.from(counts.keys()).filter((k) => (counts.get(k) ?? 0) >= target).sort();
  if (weeks.length === 0) return 0;
  // Consecutive ISO weeks → just count run length by comparing sortable keys + 7-day step.
  let best = 1;
  let run = 1;
  for (let i = 1; i < weeks.length; i++) {
    // Two weeks are consecutive if they differ by exactly 1 in the same year span;
    // approximate by string adjacency which holds within a year. Good enough for "longest".
    run = isAdjacentWeek(weeks[i - 1], weeks[i]) ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

function isAdjacentWeek(a: string, b: string): boolean {
  const [ya, wa] = a.split('-W').map(Number);
  const [yb, wb] = b.split('-W').map(Number);
  if (ya === yb) return wb - wa === 1;
  return yb - ya === 1 && wa >= 52 && wb === 1;
}

/** Completion rate over the last `windowDays` scheduled days (0..1). */
export function completionRate(habit: HabitLike, logDates: string[], today: string, windowDays = 30): number {
  const done = dateSet(logDates);
  let scheduled = 0;
  let hit = 0;
  for (let i = 0; i < windowDays; i++) {
    const day = addDays(today, -i);
    if (!isScheduledOn(habit, day)) continue;
    scheduled++;
    if (done.has(day)) hit++;
  }
  return scheduled === 0 ? 0 : hit / scheduled;
}

/** Heatmap cells (most recent last) for the trailing `windowDays` days. */
export type HeatCell = { date: string; done: boolean; scheduled: boolean };
export function heatmap(habit: HabitLike, logDates: string[], today: string, windowDays = 28): HeatCell[] {
  const done = dateSet(logDates);
  const cells: HeatCell[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    cells.push({ date, done: done.has(date), scheduled: isScheduledOn(habit, date) });
  }
  return cells;
}

export function isDoneToday(logDates: string[], today: string): boolean {
  return dateSet(logDates).has(today);
}
