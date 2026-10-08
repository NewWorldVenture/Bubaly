// Calendar busyness heat map (TimeTree gap #16) — pure + deterministic.
//
// Given the family's (recurrence-expanded) event occurrences, compute a
// per-day busyness grid for the last N weeks + advice: which days are
// overloaded, which weekday is chronically heaviest, and where the calm
// pockets are. The calendar module renders this as a compact heat strip.
import { dayKeyIn, isValidTimezone } from '@/lib/time/zoned';
import { addDays, allDayDate, familyFetchRange } from '@/lib/calendar/day';

export interface HeatEvent {
  occurrenceKey?: string;    // Explicit identity; equal-time distinct events stay distinct.
  startsAt: string;          // ISO
  endsAt: string | null;
  allDay: boolean;
}

export interface HeatDay {
  date: string;              // YYYY-MM-DD
  count: number;
  minutes: number;           // scheduled (all-day counts as 8h)
  estimated: boolean;        // Includes DATE workload or a missing-end duration estimate.
  level: 0 | 1 | 2 | 3 | 4;  // 0 calm → 4 packed
}

export interface HeatmapReport {
  days: HeatDay[];                    // oldest → newest, exactly weeks*7 entries
  busiestWeekday: string | null;      // e.g. 'Thursday'
  overloadedDates: string[];          // level 4 days in the window
  advice: string;
}

const ALL_DAY_MINUTES = 8 * 60;
const DEFAULT_EVENT_MINUTES = 60;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function validDateKey(value: string): boolean {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && dayKey(new Date(instant)) === value;
}

/** Level thresholds by scheduled minutes (count breaks ties upward). */
function levelFor(minutes: number, count: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  if (minutes >= 360 || count >= 6) return 4;
  if (minutes >= 240 || count >= 4) return 3;
  if (minutes >= 120 || count >= 2) return 2;
  return 1;
}

/**
 * Build the busyness grid for the `weeks` ending at `today` (inclusive).
 * Each occurrence counts once per occupied date. Timed minutes are clipped
 * to actual family midnights (including 23/25-hour DST dates). DATE workload
 * remains an explicit eight-hour estimate per civil date, not occupied time.
 *
 * With `timeZone` (the family's, TIME-003) "today" and each timed start day are
 * that zone's calendar days; without it they are Greenwich's, as before. An
 * all-day row is on its own date in both cases. The grid itself is keyed by
 * date either way, so the arithmetic stays on UTC dates.
 */
export function buildHeatmap(events: HeatEvent[], today = new Date(), weeks = 8, timeZone?: string): HeatmapReport {
  if (!Number.isFinite(today.getTime()) || !Number.isSafeInteger(weeks) || weeks < 1 || weeks > 520) throw new Error('Invalid heatmap window');
  const dayCount = weeks * 7;
  const zone = timeZone && isValidTimezone(timeZone) ? timeZone : 'UTC';
  const todayKey = dayKeyIn(today, zone);
  const end = new Date(`${todayKey}T00:00:00Z`);
  const start = new Date(end.getTime() - (dayCount - 1) * 86400_000);
  const buckets = Array.from({length:dayCount},(_,index) => {
    const date = dayKey(new Date(start.getTime() + index * 86400_000));
    const range = familyFetchRange(date,addDays(date,1),zone);
    return {date,start:range.timedFrom.getTime(),end:range.timedTo.getTime(),count:0,minutes:0,estimated:false};
  });
  const seen = new Map<string,string>();
  for (const e of events) {
    if (e.occurrenceKey !== undefined) {
      const value = JSON.stringify([e.startsAt,e.endsAt,e.allDay]);
      if (seen.has(e.occurrenceKey)) {
        if (seen.get(e.occurrenceKey) !== value) throw new Error('Conflicting heatmap occurrence');
        continue;
      }
      seen.set(e.occurrenceKey,value);
    }
    const firstDate = e.allDay ? allDayDate(e.startsAt) : '';
    const suppliedEndDate = e.allDay && e.endsAt !== null ? allDayDate(e.endsAt) : null;
    const untilDate = e.allDay && firstDate ? (suppliedEndDate && suppliedEndDate > firstDate ? suppliedEndDate : addDays(firstDate,1)) : '';
    const first = Date.parse(e.startsAt);
    const until = e.endsAt === null ? first + DEFAULT_EVENT_MINUTES * 60_000 : Date.parse(e.endsAt);
    if (e.allDay ? !validDateKey(firstDate) || (suppliedEndDate !== null && (!validDateKey(suppliedEndDate) || suppliedEndDate < firstDate)) : !Number.isFinite(first) || !Number.isFinite(until) || until < first) throw new Error('Invalid heatmap occurrence');
    for (const day of buckets) {
      // A skipped civil date (Apia 2011-12-30) has no timed instants. DATE
      // workload is still explicitly a civil estimate, never elapsed minutes.
      if (!e.allDay && day.end <= day.start) continue;
      const minutes = e.allDay ? (firstDate <= day.date && day.date < untilDate ? ALL_DAY_MINUTES : null)
        : first === until ? (first >= day.start && first < day.end ? 0 : null)
        : first < day.end && until > day.start ? (Math.min(until,day.end) - Math.max(first,day.start)) / 60_000 : null;
      if (minutes === null) continue;
      day.count += 1;
      day.minutes += minutes;
      day.estimated ||= e.allDay || e.endsAt === null;
    }
  }

  const days: HeatDay[] = [];
  const weekdayTotals = new Array(7).fill(0) as number[];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime() + i * 86400_000);
    const key = dayKey(d);
    const agg = buckets[i];
    days.push({ date: key, count: agg.count, minutes: agg.minutes, estimated:agg.estimated, level: levelFor(agg.minutes, agg.count) });
    weekdayTotals[d.getUTCDay()] += agg.minutes;
  }

  const overloadedDates = days.filter(d => d.level === 4).map(d => d.date);
  const anyLoad = weekdayTotals.some(t => t > 0);
  const busiestIdx = weekdayTotals.indexOf(Math.max(...weekdayTotals));
  const busiestWeekday = anyLoad ? WEEKDAYS[busiestIdx] : null;

  let advice: string;
  if (!anyLoad && days.some(day => day.count > 0)) {
    advice = 'Load looks evenly spread — nice.';
  } else if (!anyLoad) {
    advice = 'A quiet stretch — nothing scheduled in this window.';
  } else if (overloadedDates.length >= 3) {
    advice = `${overloadedDates.length} packed days in the last ${weeks} weeks — ${busiestWeekday}s carry the most. Consider moving flexible commitments to a lighter day.`;
  } else if (busiestWeekday) {
    const calmIdx = weekdayTotals.indexOf(Math.min(...weekdayTotals));
    advice = `${busiestWeekday}s are your heaviest day; ${WEEKDAYS[calmIdx]}s are calmest — a good home for anything movable.`;
  } else {
    advice = 'Load looks evenly spread — nice.';
  }

  return { days, busiestWeekday, overloadedDates, advice };
}
