// lib/meals/week-context.ts — which nights of the week the family has no time to cook.
//
// The meal planner used to plan a week in the abstract: seven identical
// evenings, each apparently free. A household's calendar says otherwise —
// Tuesday has swim at 17:30 and Thursday has a 18:00 parent meeting, and a
// braise on either of those nights is a plan the family will not follow.
//
// This module is pure on purpose. It takes complete native/source occurrences,
// resolves each dinner window into the FAMILY's zone (not the server's),
// measures the union of actual occupied instants within that window, and
// says which nights are busy and why. The planner prompt then carries the
// dates and the reasons, so the model can put the 20-minute dish where it
// belongs instead of guessing.
//
// Nothing here claims Bubaly did anything: a busy night is a fact read from a
// calendar row, and the hint names the events that made it one.

import { isValidTimezone, zonedLocalToInstant } from '@/lib/time/zoned';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';

/** Native or source occurrence data; original keys remain unchanged. */
export interface WeekCalendarEvent {
  kind?: 'native' | 'source';
  occurrenceKey?: string;
  actualStartsAt?: string;
  actualEndsAt?: string | null;
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
  if (!isValidTimezone(tz)) throw new Error('Invalid meal calendar timezone');
  const busyMinutes = options.busyMinutes ?? DEFAULT_BUSY_MINUTES;
  if (!Number.isFinite(busyMinutes) || busyMinutes <= 0) throw new Error('Invalid busy threshold');
  const days = DAY_KEY.test(weekStart) ? weekDayKeys(weekStart) : [];
  const byDate = new Map<string, { minutes: number; events: { title: string; at: number }[]; intervals: [number,number][]; from:number; to:number }>();
  for (const day of days) {
    const bounds=briefingCalendarBounds(day,tz,0,1);
    const [year,month,date]=day.split('-').map(Number);
    const skipped = bounds.timedFrom === bounds.timedTo;
    const from = skipped ? Date.parse(bounds.timedFrom) : zonedLocalToInstant(year,month,date,DINNER_WINDOW.startHour*60,tz)?.getTime();
    const to = skipped ? Date.parse(bounds.timedTo) : zonedLocalToInstant(year,month,date,DINNER_WINDOW.endHour*60,tz)?.getTime();
    if (from === undefined || to === undefined || to < from) throw new Error('Invalid dinner interval');
    byDate.set(day,{minutes:0,events:[],intervals:[],from,to});
  }
  const seen = new Map<string,string>();
  for (const event of events ?? []) {
    // DATE annotations are intentionally not a cooking-time commitment.
    if (event?.all_day) continue;
    const start=Date.parse(event?.actualStartsAt ?? event?.starts_at);
    const suppliedEnd=event?.actualEndsAt !== undefined ? event.actualEndsAt : event?.ends_at;
    const end=suppliedEnd === null || suppliedEnd === undefined ? start + (event.kind === 'source' ? 0 : DEFAULT_EVENT_MINUTES*60_000) : Date.parse(suppliedEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Invalid meal calendar interval');
    if (event.occurrenceKey !== undefined) {
      const signature=JSON.stringify([start,end,event.title]);
      if (seen.has(event.occurrenceKey)) {
        if (seen.get(event.occurrenceKey) !== signature) throw new Error('Conflicting meal calendar occurrence');
        continue;
      }
      seen.set(event.occurrenceKey,signature);
    }
    if (end === start) continue;
    for (const bucket of byDate.values()) {
      const from=Math.max(start,bucket.from),to=Math.min(end,bucket.to);
      if (to <= from) continue;
      bucket.intervals.push([from,to]);
      bucket.events.push({title:(event.title ?? '').trim() || 'Untitled event',at:from});
    }
  }
  for (const bucket of byDate.values()) {
    // Concurrent commitments occupy the same dinner minutes once.
    bucket.intervals.sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
    let [from,to]=bucket.intervals[0] ?? [0,0];
    for (const interval of bucket.intervals.slice(1)) {
      if (interval[0] > to) {bucket.minutes+=(to-from)/60_000;[from,to]=interval;}
      else to=Math.max(to,interval[1]);
    }
    bucket.minutes+=(to-from)/60_000;
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
