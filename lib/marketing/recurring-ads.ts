// lib/marketing/recurring-ads.ts
//
// The scheduling brain for recurring social ads: set a cadence once and the
// runner keeps posting on it, forever, without anyone touching it again.
//
// Pure and side-effect free — no database, no clock of its own, no network —
// so every rule below is unit-testable and the runner stays a thin loop.
//
// The hard part is not "add seven days". It is that people think in LOCAL wall
// time ("every weekday at 9am") while a scheduler stores instants, and the
// mapping between them is not a constant:
//
//   • 09:00 in America/New_York is 13:00 UTC in July and 14:00 UTC in January.
//     Adding 24h to an instant drifts an hour across a DST boundary and the ad
//     starts posting at 8am or 10am. Every occurrence is therefore computed
//     from the LOCAL calendar date, then converted.
//   • On the spring-forward day, 02:30 local does not exist. Naively converting
//     it yields 01:30 or 03:30 depending on rounding, and an ad set for 02:30
//     either double-posts or silently skips a day twice a year.
//   • On the fall-back day, 01:30 local happens TWICE. The ad must post once.
//   • "The 31st, monthly" has to mean something in February.
//
// And the property that matters most for "set once and forget": the next run is
// always strictly in the FUTURE. If the runner is down for a week, a daily ad
// posts once when it comes back — not seven times in a burst at whoever follows
// the account. Catch-up storms are the classic failure of this kind of feature
// and `nextRunAt` cannot produce one, because it never looks backwards.

/** How often a recurring ad fires. */
export type Cadence = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

export const CADENCES: Cadence[] = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];

export type RecurringAdSchedule = {
  cadence: Cadence;
  /** Local times of day as minutes after midnight (0–1439). Several = several posts a day. */
  timesOfDay: number[];
  /** weekly/biweekly only: 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  /** monthly only: 1–31, clamped to the length of the month. */
  dayOfMonth: number | null;
  /** IANA zone the local times are read in. */
  timezone: string;
};

export const DEFAULT_SCHEDULE: RecurringAdSchedule = {
  cadence: 'weekly',
  timesOfDay: [9 * 60],
  daysOfWeek: [2],
  dayOfMonth: null,
  timezone: 'UTC',
};

const MINUTES_PER_DAY = 24 * 60;
/** A year of days. Long enough for any cadence here, short enough to always end. */
const MAX_LOOKAHEAD_DAYS = 400;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    partsCache.set(timezone, dtf);
  }
  return dtf;
}

/** The wall-clock reading an observer in `timezone` sees at `instant`. */
export function localPartsAt(instant: Date, timezone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // 'en-US' with hour12:false renders midnight as 24 in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Zone offset in ms at a given instant (positive east of UTC). */
function offsetMsAt(instant: Date, timezone: string): number {
  const p = localPartsAt(instant, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant.getTime();
}

/**
 * The instant at which the clock in `timezone` reads the given local time.
 *
 * Returns null when that reading never happens — the hour skipped by
 * spring-forward. The caller decides what to do about it rather than being
 * handed a silently wrong instant.
 *
 * Two passes: the first guesses using the offset at the naive instant, the
 * second corrects it using the offset actually in force there. That converges
 * for every real zone, and the verification step catches the gap.
 */
export function zonedLocalToInstant(
  year: number, month: number, day: number, minutes: number, timezone: string,
): Date | null {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let ts = naive - offsetMsAt(new Date(naive), timezone);
  ts = naive - offsetMsAt(new Date(ts), timezone);
  const check = localPartsAt(new Date(ts), timezone);
  const matches = check.year === year && check.month === month && check.day === day
    && check.hour === hour && check.minute === minute;
  return matches ? new Date(ts) : null;
}

/**
 * The instant for a local time, moved forward when that time does not exist.
 *
 * An ad set for 02:30 must still post on the morning the clocks jump from
 * 02:00 to 03:00 — at 03:00, the first moment that exists — rather than
 * vanishing for that day. Searching minute by minute is bounded by the largest
 * real DST jump and costs nothing at this cadence.
 */
function instantForLocalTime(
  year: number, month: number, day: number, minutes: number, timezone: string,
): Date | null {
  for (let m = minutes; m < MINUTES_PER_DAY; m += 1) {
    const instant = zonedLocalToInstant(year, month, day, m, timezone);
    if (instant) return instant;
  }
  return null;
}

/** Days in a month, so "the 31st" means the 28th/29th/30th where that is the end. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of week (0 = Sunday) for a local calendar date. */
function dayOfWeekFor(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Whole days between two local calendar dates. */
function daysBetween(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
): number {
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

function normalizeTimes(timesOfDay: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const raw of timesOfDay) {
    if (!Number.isFinite(raw)) continue;
    const minutes = Math.trunc(raw);
    if (minutes >= 0 && minutes < MINUTES_PER_DAY) seen.add(minutes);
  }
  return [...seen].sort((a, b) => a - b);
}

function normalizeDays(daysOfWeek: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const raw of daysOfWeek) {
    if (!Number.isFinite(raw)) continue;
    const day = Math.trunc(raw);
    if (day >= 0 && day <= 6) seen.add(day);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Does this local date fire, for this cadence? */
function dateMatches(
  schedule: RecurringAdSchedule,
  anchor: { year: number; month: number; day: number },
  date: { year: number; month: number; day: number },
  daysOfWeek: number[],
): boolean {
  const weekday = dayOfWeekFor(date.year, date.month, date.day);
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'weekdays':
      return weekday >= 1 && weekday <= 5;
    case 'weekly':
      return daysOfWeek.includes(weekday);
    case 'biweekly': {
      if (!daysOfWeek.includes(weekday)) return false;
      // Counted in whole weeks from the anchor's week, so the alternating
      // rhythm survives a pause: resuming does not re-phase the campaign.
      const offset = daysBetween(anchor, date);
      const weeks = Math.floor((offset + dayOfWeekFor(anchor.year, anchor.month, anchor.day)) / 7);
      return weeks % 2 === 0;
    }
    case 'monthly': {
      const wanted = schedule.dayOfMonth ?? anchor.day;
      const last = daysInMonth(date.year, date.month);
      return date.day === Math.min(wanted, last);
    }
    default:
      return false;
  }
}

/**
 * The first instant strictly after `after` at which this schedule fires, or
 * null if it never does again within the lookahead.
 *
 * `anchor` is the campaign's start — it phases `biweekly` and supplies the day
 * of month when none was chosen. Everything is derived from the local calendar
 * so a DST shift moves the UTC instant, not the time the audience sees.
 */
export function nextRunAt(
  schedule: RecurringAdSchedule,
  after: Date,
  anchor: Date = after,
): Date | null {
  const timezone = isValidTimezone(schedule.timezone) ? schedule.timezone : 'UTC';
  const times = normalizeTimes(schedule.timesOfDay);
  if (times.length === 0) return null;
  const daysOfWeek = normalizeDays(schedule.daysOfWeek);
  if ((schedule.cadence === 'weekly' || schedule.cadence === 'biweekly') && daysOfWeek.length === 0) return null;

  const anchorLocal = localPartsAt(anchor, timezone);
  const cursor = localPartsAt(after, timezone);
  let { year, month, day } = cursor;

  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i += 1) {
    if (dateMatches(schedule, anchorLocal, { year, month, day }, daysOfWeek)) {
      for (const minutes of times) {
        const instant = instantForLocalTime(year, month, day, minutes, timezone);
        // Strictly after: a schedule that returned `after` itself would make
        // the runner re-fire the occurrence it just completed, forever.
        if (instant && instant.getTime() > after.getTime()) return instant;
      }
    }
    const last = daysInMonth(year, month);
    if (day >= last) { day = 1; month = month === 12 ? 1 : month + 1; if (month === 1) year += 1; }
    else day += 1;
  }
  return null;
}

export type RecurringAdWindow = {
  /** Nothing fires before this instant. */
  startsAt: Date;
  /** Nothing fires after this instant, when set. */
  endsAt?: Date | null;
  /** Stop after this many posts, when set. */
  maxOccurrences?: number | null;
  /** How many have already gone out. */
  occurrences: number;
};

export type RunDecision =
  | { run: true; at: Date; nextAfter: Date }
  | { run: false; reason: 'paused' | 'not_due' | 'window_closed' | 'occurrence_cap' | 'no_schedule' };

/**
 * Should this ad post right now, and when is the one after that?
 *
 * Split from nextRunAt so the reason an ad is NOT posting is a value the UI can
 * show — "finished: ran 12 of 12" reads very differently from "not due yet",
 * and a campaign that has quietly stopped is the thing an operator most needs
 * to see.
 */
export function decideRun(
  schedule: RecurringAdSchedule,
  window: RecurringAdWindow,
  nextRun: Date | null,
  now: Date,
  active: boolean,
): RunDecision {
  if (!active) return { run: false, reason: 'paused' };
  if (window.maxOccurrences != null && window.occurrences >= window.maxOccurrences) {
    return { run: false, reason: 'occurrence_cap' };
  }
  if (window.endsAt && now.getTime() > window.endsAt.getTime()) return { run: false, reason: 'window_closed' };
  if (!nextRun) return { run: false, reason: 'no_schedule' };
  if (nextRun.getTime() > now.getTime()) return { run: false, reason: 'not_due' };
  if (window.endsAt && nextRun.getTime() > window.endsAt.getTime()) return { run: false, reason: 'window_closed' };

  // Advance from NOW, not from the missed slot. An outage must cost the posts
  // it covered, never queue them up to land together afterwards.
  const following = nextRunAt(schedule, now, window.startsAt);
  return { run: true, at: nextRun, nextAfter: following ?? now };
}

/**
 * Which message this occurrence uses.
 *
 * Cycling a pool is what stops "set once" turning into the same sentence in a
 * follower's feed every Tuesday until someone notices. Deterministic in the
 * occurrence number, so a re-run of the same occurrence produces the same text
 * and the ledger stays reproducible.
 */
export function variantForOccurrence(variants: readonly string[], occurrence: number): string | null {
  const usable = variants.map((v) => v.trim()).filter(Boolean);
  if (usable.length === 0) return null;
  const index = ((occurrence % usable.length) + usable.length) % usable.length;
  return usable[index];
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clockLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** One line describing the cadence, for the admin list. */
export function describeSchedule(schedule: RecurringAdSchedule): string {
  const times = normalizeTimes(schedule.timesOfDay).map(clockLabel).join(', ') || '—';
  const days = normalizeDays(schedule.daysOfWeek).map((d) => DAY_LABELS[d]).join(', ');
  const when = (() => {
    switch (schedule.cadence) {
      case 'daily': return 'Every day';
      case 'weekdays': return 'Weekdays';
      case 'weekly': return days ? `Weekly on ${days}` : 'Weekly';
      case 'biweekly': return days ? `Every other week on ${days}` : 'Every other week';
      case 'monthly': return `Monthly on day ${schedule.dayOfMonth ?? '—'}`;
      default: return 'Unknown cadence';
    }
  })();
  return `${when} at ${times} (${schedule.timezone})`;
}

/**
 * "09:00, 17:30" → local minutes after midnight.
 *
 * Lives here, not beside the server action that calls it, for two reasons.
 * Every export of a 'use server' module is a callable endpoint, so a pure
 * string parser has no business being one — and Next.js flatly refuses to
 * build a 'use server' file that exports anything non-async, which is how this
 * one announced itself.
 */
export function parseTimesOfDay(input: string): number[] {
  const out = new Set<number>();
  for (const piece of input.split(/[,\s]+/)) {
    const match = /^(\d{1,2}):([0-5]\d)$/.exec(piece.trim());
    if (!match) continue;
    const hours = Number(match[1]);
    if (hours > 23) continue;
    out.add(hours * 60 + Number(match[2]));
  }
  return [...out].sort((a, b) => a - b);
}

/** One message per line. Blank lines separate; they are not empty ads. */
export function parseVariants(input: string): string[] {
  return input.split('\n').map((line) => line.trim()).filter(Boolean);
}
