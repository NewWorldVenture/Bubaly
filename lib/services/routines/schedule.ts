// Turning "every Sunday at 5pm" into something a cron can fire (§19, §58).
//
// WHY A PARSER AND NOT A PICKER: a family says when they want something in
// words, and the whole promise of a routine is that saying it is enough. But a
// schedule the family did not mean is worse than no routine at all — it fires
// at 3am, or every day instead of every Sunday, and they stop trusting it. So
// this parser is deliberately CONSERVATIVE: it recognises the phrasings people
// actually use and returns `null` for everything else, and `null` means the
// caller asks a question rather than guessing.
//
// TWO KINDS OF SCHEDULE, because families use both:
//
//   cron      "every Sunday at 5pm" — a wall-clock repeat.
//   relative  "two days before every trip" — anchored to rows that MOVE. The
//             anchor is a table and a date column, so when the trip is
//             rescheduled the next fire moves with it. That is the difference
//             between a routine and a calendar entry.
//
// This file is pure: no database, no clock of its own. `nextRunAt` takes the
// instant to compute from, so the cron, the tests and the UI preview all agree.
import type { RoutineAnchor } from './anchors';

export type CronSchedule = {
  kind: 'cron';
  /** Standard 5-field cron, minute-hour-dom-month-dow, in the family's zone. */
  expr: string;
  /** What the family said, kept so the UI can show it back to them. */
  said: string;
};

export type RelativeSchedule = {
  kind: 'relative';
  anchor: RoutineAnchor;
  /** Negative is before the anchor date; positive is after. */
  offsetDays: number;
  /** Local hour to fire at, 0–23. */
  atHour: number;
  said: string;
};

export type Schedule = CronSchedule | RelativeSchedule;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14,
};

/** "morning" and friends, for phrasings with no clock time. */
const DAYPART_HOURS: Record<string, number> = {
  morning: 8, 'first thing': 7, midday: 12, noon: 12, afternoon: 14, evening: 18, night: 20, bedtime: 20,
};

const DEFAULT_HOUR = 9;

/** `5pm`, `5:30pm`, `17:00`, `at 5` → minutes past midnight, or null. */
export function parseClockTime(text: string): { hour: number; minute: number } | null {
  const ampm = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (ampm) {
    let hour = Number(ampm[1]);
    if (hour > 12) return null;
    if (ampm[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    return { hour, minute: Number(ampm[2] ?? 0) };
  }
  const h24 = /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  if (h24) return { hour: Number(h24[1]), minute: Number(h24[2]) };
  const bare = /\bat\s+(\d{1,2})\b(?!\s*(?:days?|weeks?|hours?|:))/i.exec(text);
  if (bare) {
    const hour = Number(bare[1]);
    // "at 7" from a family means the waking hour, not 7am on a 24h clock —
    // but 13–23 are unambiguous, so they are taken at face value.
    if (hour >= 0 && hour <= 23) return { hour: hour <= 7 ? hour + 12 : hour, minute: 0 };
  }
  for (const [word, hour] of Object.entries(DAYPART_HOURS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return { hour, minute: 0 };
  }
  return null;
}

function numberFrom(word: string): number | null {
  const digits = Number(word);
  if (Number.isInteger(digits) && digits > 0) return digits;
  return NUMBER_WORDS[word.toLowerCase()] ?? null;
}

/**
 * A schedule from what the family typed, or `null` when it is not clear.
 *
 * Returning null is a feature: `create_automation` asks "when should I do
 * that?" instead of inventing a time, and no routine ever fires at an hour
 * nobody chose.
 */
export function parseSchedule(text: string, anchors: RoutineAnchor[] = []): Schedule | null {
  const said = text.trim();
  if (!said) return null;
  const q = said.toLowerCase();

  // ── Relative: "two days before every trip", "the night before each game" ──
  const relative = /\b(?:(\d+|a|an|one|two|three|four|five|six|seven|ten|fourteen)\s+)?(day|days|week|weeks|night)\s+(before|after)\s+(?:every|each|any|the)?\s*([a-z ]+?)\b/i.exec(q);
  if (relative) {
    const count = relative[1] ? numberFrom(relative[1]) : 1;
    if (count !== null) {
      const unit = relative[2].toLowerCase();
      const days = unit.startsWith('week') ? count * 7 : count;
      const direction = relative[3].toLowerCase() === 'before' ? -1 : 1;
      const subject = relative[4].trim();
      const anchor = anchors.find((a) => a.matches.some((m) => subject.includes(m)));
      if (anchor) {
        // "the night before" carries its own hour through DAYPART_HOURS
        // ('night' → 20:00), which is why there is no special case here.
        const time = parseClockTime(q);
        return { kind: 'relative', anchor, offsetDays: direction * days, atHour: time?.hour ?? DEFAULT_HOUR, said };
      }
    }
  }

  // ── Cron: the wall-clock repeats ────────────────────────────────────────
  const time = parseClockTime(q);
  const hour = time?.hour ?? DEFAULT_HOUR;
  const minute = time?.minute ?? 0;

  // "every Sunday", "on Mondays", "every Tue and Thu"
  const days = Object.keys(WEEKDAYS)
    .filter((name) => new RegExp(`\\b${name}s?\\b`, 'i').test(q))
    .map((name) => WEEKDAYS[name]);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length) return { kind: 'cron', expr: `${minute} ${hour} * * ${unique.join(',')}`, said };

  if (/\bevery\s+weekday\b|\bweekdays\b|\bevery\s+school\s+day\b/i.test(q)) {
    return { kind: 'cron', expr: `${minute} ${hour} * * 1-5`, said };
  }
  if (/\bevery\s+weekend\b|\bweekends\b/i.test(q)) {
    return { kind: 'cron', expr: `${minute} ${hour} * * 0,6`, said };
  }
  if (/\bevery\s+day\b|\bdaily\b|\beach\s+day\b|\bevery\s+morning\b|\bevery\s+evening\b|\bevery\s+night\b/i.test(q)) {
    return { kind: 'cron', expr: `${minute} ${hour} * * *`, said };
  }
  // "on the 1st", "every month on the 15th"
  const dom = /\b(?:every\s+month\s+)?(?:on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i.exec(q);
  if (dom && /\bmonth|monthly\b/i.test(q)) {
    const day = Number(dom[1]);
    if (day >= 1 && day <= 28) return { kind: 'cron', expr: `${minute} ${hour} ${day} * *`, said };
  }
  if (/\bevery\s+month\b|\bmonthly\b/i.test(q)) return { kind: 'cron', expr: `${minute} ${hour} 1 * *`, said };
  if (/\bevery\s+week\b|\bweekly\b/i.test(q)) return { kind: 'cron', expr: `${minute} ${hour} * * 0`, said };

  return null;
}

/** A cron field's matching values, for the small subset this file emits. */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      return value >= Math.max(lo, min) && value <= Math.min(hi, max);
    }
    return Number(part) === value;
  });
}

/** The parts of an instant, in a family's own zone. */
function zoned(instant: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour), minute: Number(parts.minute),
    weekday: Math.max(0, weekdays.indexOf(String(parts.weekday))),
  };
}

/**
 * The next time a cron schedule fires after `from`, in the family's zone.
 *
 * Minute-by-minute would be 500k iterations a year; this walks HOURS and only
 * then places the minute, which is enough because every expression this file
 * produces fires at a fixed minute. A year without a match returns null rather
 * than looping — an impossible schedule is a bug to see, not to hang on.
 */
export function nextCronRun(expr: string, from: Date, tz: string): Date | null {
  const [minuteField, hourField, domField, monthField, dowField] = expr.split(/\s+/);
  const minute = Number(minuteField);
  if (!Number.isInteger(minute)) return null;

  // Start at the top of the next hour so a schedule never fires twice in one.
  let cursor = new Date(from.getTime() + 60_000 - (from.getTime() % 60_000));
  const limit = new Date(from.getTime() + 366 * 86_400_000);

  while (cursor <= limit) {
    const at = zoned(cursor, tz);
    const matches = fieldMatches(hourField, at.hour, 0, 23)
      && fieldMatches(domField, at.day, 1, 31)
      && fieldMatches(monthField, at.month, 1, 12)
      && fieldMatches(dowField, at.weekday, 0, 6);
    if (matches && at.minute === minute) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
    // Skip the rest of an hour that cannot match, which is most of them.
    if (!matches && zoned(cursor, tz).minute !== 0) {
      cursor = new Date(cursor.getTime() + (60 - zoned(cursor, tz).minute) * 60_000);
    }
  }
  return null;
}

/**
 * When a relative schedule fires for one anchor date: the offset applied to the
 * anchor's day, at the routine's hour, in the family's zone.
 *
 * Returns null when that instant has already passed — a trip two days from now
 * cannot have a "two days before" fire, and pretending otherwise would send a
 * "get ready" message about something happening tomorrow.
 */
export function nextRelativeRun(schedule: RelativeSchedule, anchorDate: string, from: Date, tz: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(anchorDate);
  if (!day) return null;
  const base = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const target = new Date(base + schedule.offsetDays * 86_400_000);
  const key = target.toISOString().slice(0, 10);

  // Place the local hour: build the instant, then correct for the zone offset.
  const naive = new Date(`${key}T${String(schedule.atHour).padStart(2, '0')}:00:00Z`);
  const at = zoned(naive, tz);
  const drift = (at.hour - schedule.atHour) * 3_600_000 + at.minute * 60_000;
  const fires = new Date(naive.getTime() - drift);
  return fires > from ? fires : null;
}
