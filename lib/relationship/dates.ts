// lib/relationship/dates.ts — pure date math for the Relationship Helper.
// Deterministic (inject `from`) so it's fully unit-testable. Handles recurring
// annual dates (anniversaries, birthdays) and one-off date nights/milestones.

export type RelKind =
  | 'anniversary'
  | 'birthday'
  | 'first_date'
  | 'date_night'
  | 'milestone'
  | 'custom';

export type RelDate = {
  id: string;
  kind: RelKind;
  title: string;
  /** 'YYYY-MM-DD'. For recurring dates the year is the original/started year. */
  eventDate: string;
  recursAnnually: boolean;
  reminderDaysBefore: number;
  status?: string | null;
};

export type UpcomingDate = RelDate & {
  /** The next future (or today) occurrence. */
  next: Date;
  /** Whole days from `from` to `next` (0 = today). */
  days: number;
  /** For recurring dates, the ordinal this occurrence marks (e.g. 5th anniversary,
   *  the age turned). null for one-offs. */
  years: number | null;
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Parse a 'YYYY-MM-DD' string into local date parts. */
export function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * The next occurrence of an event at or after the start of `from`'s day.
 * For one-off dates, returns the date itself (which may be in the past — callers
 * can filter). For recurring dates, returns this year's month/day, or next
 * year's if it has already passed.
 */
export function nextOccurrence(eventDate: string, recursAnnually: boolean, from: Date = new Date()): Date | null {
  const p = parseYMD(eventDate);
  if (!p) return null;
  if (!recursAnnually) return new Date(p.y, p.m - 1, p.d);

  const today = startOfDay(from);
  let occ = new Date(today.getFullYear(), p.m - 1, p.d);
  if (occ.getTime() < today.getTime()) occ = new Date(today.getFullYear() + 1, p.m - 1, p.d);
  return occ;
}

/** Whole days from `from` to `target` (both floored to local midnight). */
export function daysUntil(target: Date, from: Date = new Date()): number {
  return Math.round((startOfDay(target).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

/** Ordinal suffix: 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Human countdown label. */
export function formatCountdown(days: number): string {
  if (days < 0) return 'Passed';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `in ${days} days`;
  if (days < 14) return 'in 1 week';
  if (days < 31) return `in ${Math.round(days / 7)} weeks`;
  if (days < 60) return 'in 1 month';
  return `in ${Math.round(days / 30)} months`;
}

/**
 * Resolve a list of dates to their next occurrences, dropping past one-offs,
 * optionally limiting to a window, sorted soonest-first.
 */
export function upcomingDates(
  dates: RelDate[],
  opts: { from?: Date; withinDays?: number } = {},
): UpcomingDate[] {
  const from = opts.from ?? new Date();
  const out: UpcomingDate[] = [];
  for (const d of dates) {
    const next = nextOccurrence(d.eventDate, d.recursAnnually, from);
    if (!next) continue;
    const days = daysUntil(next, from);
    if (days < 0) continue; // a one-off that has already passed
    if (opts.withinDays != null && days > opts.withinDays) continue;
    const p = parseYMD(d.eventDate);
    const years = d.recursAnnually && p ? next.getFullYear() - p.y : null;
    out.push({ ...d, next, days, years: years != null && years >= 0 ? years : null });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** True when a date is within its reminder window (and not already passed). */
export function isReminderDue(d: RelDate, from: Date = new Date()): boolean {
  const next = nextOccurrence(d.eventDate, d.recursAnnually, from);
  if (!next) return false;
  const days = daysUntil(next, from);
  return days >= 0 && days <= Math.max(0, d.reminderDaysBefore);
}

/**
 * Dates that are currently inside their reminder window (e.g. a 14-day reminder
 * fires when the date is ≤14 days out), soonest first. Used for proactive nudges
 * like the home-dashboard reminder.
 */
export function upcomingRelationship(dates: RelDate[], from: Date = new Date()): UpcomingDate[] {
  return upcomingDates(dates, { from, withinDays: 60 }).filter((d) => d.days <= d.reminderDaysBefore);
}

/** A short label for a recurring milestone, e.g. "5th anniversary", "turns 34". */
export function milestoneLabel(d: UpcomingDate): string | null {
  if (d.years == null || d.years <= 0) return null;
  if (d.kind === 'birthday') return `turns ${d.years}`;
  if (d.kind === 'anniversary') return `${ordinal(d.years)} anniversary`;
  return `${ordinal(d.years)} year`;
}
