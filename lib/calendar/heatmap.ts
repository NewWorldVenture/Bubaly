// Calendar busyness heat map (TimeTree gap #16) — pure + deterministic.
//
// Given the family's (recurrence-expanded) event occurrences, compute a
// per-day busyness grid for the last N weeks + advice: which days are
// overloaded, which weekday is chronically heaviest, and where the calm
// pockets are. The calendar module renders this as a compact heat strip.

export interface HeatEvent {
  startsAt: string;          // ISO
  endsAt: string | null;
  allDay: boolean;
}

export interface HeatDay {
  date: string;              // YYYY-MM-DD
  count: number;
  minutes: number;           // scheduled (all-day counts as 8h)
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

function minutesOf(e: HeatEvent): number {
  if (e.allDay) return ALL_DAY_MINUTES;
  if (!e.endsAt) return DEFAULT_EVENT_MINUTES;
  const ms = new Date(e.endsAt).getTime() - new Date(e.startsAt).getTime();
  if (!isFinite(ms) || ms <= 0) return DEFAULT_EVENT_MINUTES;
  return Math.min(Math.round(ms / 60000), ALL_DAY_MINUTES * 2);
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
 * Events outside the window are ignored; multi-day handling is start-day
 * based (each occurrence lands on its start date, which is how families
 * read a calendar: "what starts that day").
 */
export function buildHeatmap(events: HeatEvent[], today = new Date(), weeks = 8): HeatmapReport {
  const dayCount = weeks * 7;
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end.getTime() - (dayCount - 1) * 86400_000);

  const byDay = new Map<string, { count: number; minutes: number }>();
  for (const e of events) {
    const d = new Date(e.startsAt);
    if (isNaN(d.getTime()) || d < start || d.getTime() >= end.getTime() + 86400_000) continue;
    const key = dayKey(d);
    const cur = byDay.get(key) ?? { count: 0, minutes: 0 };
    cur.count += 1;
    cur.minutes += minutesOf(e);
    byDay.set(key, cur);
  }

  const days: HeatDay[] = [];
  const weekdayTotals = new Array(7).fill(0) as number[];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime() + i * 86400_000);
    const key = dayKey(d);
    const agg = byDay.get(key) ?? { count: 0, minutes: 0 };
    days.push({ date: key, count: agg.count, minutes: agg.minutes, level: levelFor(agg.minutes, agg.count) });
    weekdayTotals[d.getUTCDay()] += agg.minutes;
  }

  const overloadedDates = days.filter(d => d.level === 4).map(d => d.date);
  const anyLoad = weekdayTotals.some(t => t > 0);
  const busiestIdx = weekdayTotals.indexOf(Math.max(...weekdayTotals));
  const busiestWeekday = anyLoad ? WEEKDAYS[busiestIdx] : null;

  let advice: string;
  if (!anyLoad) {
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
