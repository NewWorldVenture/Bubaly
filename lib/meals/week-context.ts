// lib/meals/week-context.ts — which nights of the week the family has no time to cook.
//
// The meal planner used to plan a week in the abstract: seven identical
// evenings, each apparently free. A household's calendar says otherwise —
// Tuesday has swim at 17:30 and Thursday has a 18:00 parent meeting, and a
// braise on either of those nights is a plan the family will not follow.
//
// This module is pure on purpose. It takes the week's `calendar_events` rows
// exactly as they come out of Supabase, resolves each one into the FAMILY's
// zone (not the server's), measures how much of the dinner window it eats, and
// says which nights are busy and why. The planner prompt then carries the
// dates and the reasons, so the model can put the 20-minute dish where it
// belongs instead of guessing.
//
// Nothing here claims Bubaly did anything: a busy night is a fact read from a
// calendar row, and the hint names the events that made it one.

/** The rows this module reads. A subset of `calendar_events` (0002). */
export interface WeekCalendarEvent {
  title?: string | null;
  starts_at: string;
  ends_at?: string | null;
  all_day?: boolean | null;
  category?: string | null;
}

/**
 * When dinner happens. An event overlapping this window is what makes a night
 * busy; a 09:00 dentist appointment does not stop anyone cooking at seven.
 */
export const DINNER_WINDOW = { startHour: 16, endHour: 20 } as const;

/** Assumed length of an event whose row carries no `ends_at`. */
const DEFAULT_EVENT_MINUTES = 60;

/** Minutes of the dinner window that have to be committed before a night is "busy". */
export const DEFAULT_BUSY_MINUTES = 45;

/** How many named events the hint lists per night before it stops. */
const MAX_REASONS_PER_NIGHT = 2;

export interface NightLoad {
  /** `YYYY-MM-DD` in the family's zone. */
  date: string;
  /** English weekday name — the planner prompt is English; the UI uses its own catalogue. */
  weekday: string;
  /** Minutes of the dinner window taken by calendar events. */
  eveningMinutes: number;
  /** Titles of the events that overlap the dinner window, in start order. */
  events: string[];
  busy: boolean;
}

export interface BusyNight {
  date: string;
  weekday: string;
  /** What makes it busy, e.g. "Swim practice, Piano". Never empty when `busy`. */
  reason: string;
}

export interface WeekContext {
  weekStart: string;
  /** All seven nights, Monday first, whether busy or not. */
  nights: NightLoad[];
  busyNights: BusyNight[];
  /** One line for the planner prompt, or null when the week has no busy night. */
  hint: string | null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The seven `YYYY-MM-DD` keys of a week, Monday first. Duplicated from the planner
 *  deliberately: this module must not depend on the prompt builder. */
function weekDayKeys(weekStart: string): string[] {
  const base = Date.parse(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}

/** Weekday name for a `YYYY-MM-DD` key, resolved in UTC so the key alone decides it. */
export function weekdayName(dayKey: string): string {
  const at = new Date(`${dayKey}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? '' : WEEKDAYS[at.getUTCDay()];
}

type LocalMoment = { dayKey: string; minutesIntoDay: number };

/**
 * Where an instant falls in the family's zone.
 *
 * `Intl` rather than arithmetic on the offset: a household in
 * America/New_York crosses a DST boundary twice a year, and an event at 18:00
 * local is at 22:00Z for half the year and 23:00Z for the other half. Reading
 * the local wall clock is the only version that is right on both sides.
 */
function localMoment(iso: string, tz: string): LocalMoment | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const dayKey = `${get('year')}-${get('month')}-${get('day')}`;
    // 'en-CA' renders midnight as 24 in some runtimes; both spellings mean 0.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    if (!DAY_KEY.test(dayKey) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { dayKey, minutesIntoDay: hour * 60 + minute };
  } catch {
    // An unknown zone is a bad `families.timezone`, not a reason to lose the week.
    return localMoment(iso, 'UTC');
  }
}

/** Minutes of [startHour, endHour) on `dayKey` that the event occupies. */
function overlapMinutes(
  start: LocalMoment,
  endMinutesFromStart: number,
  dayKey: string,
  window: { startHour: number; endHour: number },
): number {
  const windowStart = window.startHour * 60;
  const windowEnd = window.endHour * 60;
  // The event's span expressed in minutes from midnight of ITS OWN local day,
  // so an event running past midnight still contributes to the evening it began.
  const from = start.minutesIntoDay;
  const to = from + Math.max(0, endMinutesFromStart);
  if (start.dayKey !== dayKey) return 0;
  const overlap = Math.min(to, windowEnd) - Math.max(from, windowStart);
  return overlap > 0 ? overlap : 0;
}

export interface ScoreOptions {
  /** IANA zone of the family. Defaults to UTC, which is what `families.timezone` defaults to. */
  tz?: string;
  /** Minutes of committed dinner window that make a night busy. */
  busyMinutes?: number;
}

/**
 * Score the seven nights of `weekStart` against the family's calendar.
 *
 * All-day rows are ignored: a school holiday is on the calendar all day and
 * makes cooking easier, not harder. Only something that actually sits in the
 * dinner window counts.
 */
export function scoreWeekNights(
  weekStart: string,
  events: WeekCalendarEvent[],
  options: ScoreOptions = {},
): WeekContext {
  const tz = options.tz || 'UTC';
  const busyMinutes = options.busyMinutes ?? DEFAULT_BUSY_MINUTES;
  const days = DAY_KEY.test(weekStart) ? weekDayKeys(weekStart) : [];
  const byDate = new Map<string, { minutes: number; events: { title: string; at: number }[] }>();
  for (const day of days) byDate.set(day, { minutes: 0, events: [] });

  for (const event of events ?? []) {
    if (event?.all_day) continue;
    if (!event?.starts_at) continue;
    const start = localMoment(event.starts_at, tz);
    if (!start) continue;
    const bucket = byDate.get(start.dayKey);
    if (!bucket) continue;
    const endsAt = event.ends_at ? new Date(event.ends_at).getTime() : NaN;
    const startsAt = new Date(event.starts_at).getTime();
    const spanMinutes = Number.isFinite(endsAt) && endsAt > startsAt
      ? Math.round((endsAt - startsAt) / 60_000)
      : DEFAULT_EVENT_MINUTES;
    const minutes = overlapMinutes(start, spanMinutes, start.dayKey, DINNER_WINDOW);
    if (minutes <= 0) continue;
    bucket.minutes += minutes;
    bucket.events.push({ title: (event.title ?? '').trim() || 'Untitled event', at: start.minutesIntoDay });
  }

  const nights: NightLoad[] = days.map((date) => {
    const bucket = byDate.get(date)!;
    const titles = [...bucket.events].sort((a, b) => a.at - b.at || a.title.localeCompare(b.title)).map((e) => e.title);
    return {
      date,
      weekday: weekdayName(date),
      eveningMinutes: bucket.minutes,
      events: titles,
      busy: bucket.minutes >= busyMinutes,
    };
  });

  const busyNights: BusyNight[] = nights
    .filter((n) => n.busy)
    .map((n) => ({
      date: n.date,
      weekday: n.weekday,
      reason: n.events.slice(0, MAX_REASONS_PER_NIGHT).join(', '),
    }));

  return { weekStart, nights, busyNights, hint: quickMealHint(busyNights) };
}

/**
 * The single prompt line the planner adds. Null when nothing is busy, so a
 * clear week says nothing rather than saying "no busy nights" — the model
 * reads an absent constraint better than a negated one.
 */
export function quickMealHint(busyNights: BusyNight[]): string | null {
  if (!busyNights.length) return null;
  const parts = busyNights.map((n) => `${n.weekday} ${n.date}${n.reason ? ` (${n.reason})` : ''}`);
  return `Busy evenings — plan a 20-minute, one-pan or make-ahead dinner on these: ${parts.join('; ')}.`;
}
