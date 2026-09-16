// lib/relationship/dates.ts — pure date math for the Relationship Helper.
// Handles recurring annual dates (anniversaries, birthdays) and one-off date
// nights/milestones.
//
// ── The anchor is a DAY KEY, not an instant ─────────────────────────────────
//
// This took `from: Date = new Date()` and floored it with
// `setHours(0, 0, 0, 0)` — the HOST's midnight. On a UTC server that is 5pm in
// California, so for the last seven hours of every day the whole module was a
// day ahead of the family: a birthday still a day away already read "Today",
// and today's already read "Passed" and was dropped from the list entirely
// (`upcomingDates` filters `days < 0`).
//
// "Deterministic (inject `from`) so it's fully unit-testable" is what the header
// used to say, and it was true and beside the point: every caller took the
// default, and the default was the server's clock. A parameter that is only
// ever injected by tests is not a seam, it is a comment.
//
// So there is no default now, and the unit is a `YYYY-MM-DD` day key. Both
// sides of every subtraction are parsed as UTC midnight — not a claim that
// anyone is in UTC, but how two calendar days are subtracted with no zone
// entering into it. A birthday is a date on a calendar, not an instant, and
// this module now says so in its types.

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
  /**
   * The next future (or today) occurrence, as a `YYYY-MM-DD` day key.
   *
   * A key rather than a `Date`, because the only thing any caller ever read off
   * the old `Date` was `getFullYear()` — and a UTC-midnight `Date` read with
   * `getFullYear()` on a host west of UTC gives the PREVIOUS year for January
   * 1st, which is exactly the kind of quiet wrongness this module is being
   * cleaned of. `nextKey.slice(0, 4)` cannot do that.
   */
  nextKey: string;
  /** Whole days from `todayKey` to `nextKey` (0 = today). */
  days: number;
  /** For recurring dates, the ordinal this occurrence marks (e.g. 5th anniversary,
   *  the age turned). null for one-offs. */
  years: number | null;
};

const DAY = 86_400_000;

/** A `YYYY-MM-DD` key as the UTC-midnight instant that stands for that day. */
function keyMs(key: string): number {
  return Date.parse(`${key.slice(0, 10)}T00:00:00Z`);
}

/** Build a `YYYY-MM-DD` key from calendar parts. */
function toKey(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

/** Parse a 'YYYY-MM-DD' string into calendar parts. */
export function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/**
 * The next occurrence of an event on or after `todayKey`, as a day key.
 * For one-off dates, returns the date itself (which may be in the past —
 * callers filter). For recurring dates, returns this year's month/day, or next
 * year's if it has already passed.
 */
export function nextOccurrence(eventDate: string, recursAnnually: boolean, todayKey: string): string | null {
  const p = parseYMD(eventDate);
  if (!p) return null;
  if (!recursAnnually) return toKey(p.y, p.m, p.d);

  const today = parseYMD(todayKey);
  if (!today) return null;
  // Feb 29 in a non-leap year resolves the way `Date` has always resolved it
  // here (to Mar 1), which is a product decision nobody has made; it is left
  // exactly as it was rather than changed under cover of a timezone fix.
  const occ = new Date(Date.UTC(today.y, p.m - 1, p.d));
  const thisYear = toKey(occ.getUTCFullYear(), occ.getUTCMonth() + 1, occ.getUTCDate());
  if (keyMs(thisYear) >= keyMs(todayKey)) return thisYear;
  const nextOcc = new Date(Date.UTC(today.y + 1, p.m - 1, p.d));
  return toKey(nextOcc.getUTCFullYear(), nextOcc.getUTCMonth() + 1, nextOcc.getUTCDate());
}

/** Whole days from `todayKey` to `targetKey` (negative = already passed). */
export function daysUntil(targetKey: string, todayKey: string): number {
  return Math.round((keyMs(targetKey) - keyMs(todayKey)) / DAY);
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
  todayKey: string,
  opts: { withinDays?: number } = {},
): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  for (const d of dates) {
    const nextKey = nextOccurrence(d.eventDate, d.recursAnnually, todayKey);
    if (!nextKey) continue;
    const days = daysUntil(nextKey, todayKey);
    if (days < 0) continue; // a one-off that has already passed
    if (opts.withinDays != null && days > opts.withinDays) continue;
    const p = parseYMD(d.eventDate);
    const years = d.recursAnnually && p ? Number(nextKey.slice(0, 4)) - p.y : null;
    out.push({ ...d, nextKey, days, years: years != null && years >= 0 ? years : null });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** True when a date is within its reminder window (and not already passed). */
export function isReminderDue(d: RelDate, todayKey: string): boolean {
  const nextKey = nextOccurrence(d.eventDate, d.recursAnnually, todayKey);
  if (!nextKey) return false;
  const days = daysUntil(nextKey, todayKey);
  return days >= 0 && days <= Math.max(0, d.reminderDaysBefore);
}

/**
 * Dates that are currently inside their reminder window (e.g. a 14-day reminder
 * fires when the date is ≤14 days out), soonest first. Used for proactive nudges
 * like the home-dashboard reminder.
 */
export function upcomingRelationship(dates: RelDate[], todayKey: string): UpcomingDate[] {
  return upcomingDates(dates, todayKey, { withinDays: 60 }).filter((d) => d.days <= d.reminderDaysBefore);
}

/** A short label for a recurring milestone, e.g. "5th anniversary", "turns 34". */
export function milestoneLabel(d: UpcomingDate): string | null {
  if (d.years == null || d.years <= 0) return null;
  if (d.kind === 'birthday') return `turns ${d.years}`;
  if (d.kind === 'anniversary') return `${ordinal(d.years)} anniversary`;
  return `${ordinal(d.years)} year`;
}
