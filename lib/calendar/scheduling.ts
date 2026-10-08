import { addDaysToDayKey, dayKeyInTz, zonedDayBoundsMs, zonedTimeMs } from '@/lib/services/scope';
import { allDayBusyInterval } from '@/lib/calendar/event-dates';
import { exactIntervalOf, exactInstantMilliseconds, formatExactInstant, parseExactInstant, type ExactInterval } from './exact-instant';
// Pure calendar scheduling engine — no I/O, fully unit-tested. Powers the AI
// "find a time everyone is free" feature. The context lens is supported by the
// engine via the optional in-memory `context` event property; it needs no DB
// column, so this slice ships without a migration.

export type CalendarContext = 'family' | 'personal' | 'work';

export const CONTEXTS: CalendarContext[] = ['family', 'personal', 'work'];

export const CONTEXT_LABELS: Record<CalendarContext, string> = {
  family: 'Family',
  personal: 'Personal',
  work: 'Work',
};

// Tailwind text/bg tokens per context for badges + dots.
export const CONTEXT_META: Record<CalendarContext, { dot: string; chip: string }> = {
  family: { dot: 'bg-brand', chip: 'bg-brand/10 text-brand-text' },
  personal: { dot: 'bg-emerald-500', chip: 'bg-emerald-500/10 text-emerald-500' },
  work: { dot: 'bg-amber-500', chip: 'bg-amber-500/10 text-amber-500' },
};

export function isCalendarContext(v: unknown): v is CalendarContext {
  return v === 'family' || v === 'personal' || v === 'work';
}

export type Interval = { start: number; end: number; exactInterval?: ExactInterval }; // epoch ms compatibility; exact endpoints govern decisions
const ticks = (value: number) => parseExactInstant(new Date(value).toISOString());
export function intervalTicks(interval: Interval): { start: bigint; end: bigint } {
  const exact = exactIntervalOf({ interval, exactInterval: interval.exactInterval });
  return { start: parseExactInstant(exact.start), end: parseExactInstant(exact.end) };
}
function fromTicks(start: bigint, end: bigint, exact: boolean): Interval {
  return { start: exactInstantMilliseconds(start), end: exactInstantMilliseconds(end),
    ...(exact ? { exactInterval: { start: formatExactInstant(start), end: formatExactInstant(end) } } : {}) };
}
export type BusyEvent = {
  starts_at: string;
  ends_at?: string | null;
  all_day?: boolean | null;
  context?: CalendarContext | null;
  assignee_id?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Convert events into busy intervals, optionally filtered to certain contexts. */
export function busyIntervals(events: BusyEvent[], contexts: CalendarContext[] | undefined, tz: string): Interval[] {
  const out: Interval[] = [];
  for (const e of events) {
    if (contexts && contexts.length > 0 && !contexts.includes((e.context ?? 'family'))) continue;
    const start = new Date(e.starts_at).getTime();
    if (Number.isNaN(start)) continue;
    let end: number;
    if (e.all_day) {
      // A stored all-day DATE names the family's day without an instant offset.
      // Resolve both date boundaries there so DST keeps the full 23/25-hour day.
      out.push(allDayBusyInterval(e, tz));
      continue;
    }
    let preciseStart: bigint;
    try { preciseStart = parseExactInstant(e.starts_at); } catch { continue; }
    let preciseEnd = preciseStart + 1_800_000_000_000n;
    if (e.ends_at) { try { preciseEnd = parseExactInstant(e.ends_at); } catch { /* Keep the legacy invalid-end estimate. */ } }
    if (preciseEnd === preciseStart) continue;
    if (preciseEnd < preciseStart) preciseEnd = preciseStart + 1_800_000_000_000n;
    if (preciseStart % 1_000_000n !== 0n || preciseEnd % 1_000_000n !== 0n) {
      out.push(fromTicks(preciseStart, preciseEnd, true));
      continue;
    }
    const rawEnd = e.ends_at ? new Date(e.ends_at).getTime() : start + 30 * 60 * 1000;
    // A saved point occupies no time, so it must neither gain a fictitious
    // duration nor split a continuous free gap into two shorter gaps.
    if (rawEnd === start) continue;
    end = Number.isNaN(rawEnd) || rawEnd <= start ? start + 30 * 60 * 1000 : rawEnd;
    out.push({ start, end });
  }
  return mergeIntervals(out);
}

/** Merge overlapping/adjacent intervals into a sorted, non-overlapping set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  if (intervals.some(interval => interval.exactInterval)) {
    const sorted = intervals.map(intervalTicks).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    const merged = [{ ...sorted[0] }];
    for (const cur of sorted.slice(1)) {
      const last = merged[merged.length - 1];
      if (cur.start <= last.end) { if (cur.end > last.end) last.end = cur.end; }
      else merged.push({ ...cur });
    }
    return merged.map(interval => fromTicks(interval.start, interval.end, true));
  }
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

/** Invert busy intervals into free gaps within [windowStart, windowEnd]. */
export function freeGaps(busy: Interval[], windowStart: number, windowEnd: number, exactWindow?: ExactInterval): Interval[] {
  if (exactWindow || busy.some(interval => interval.exactInterval)) {
    const start = exactWindow ? parseExactInstant(exactWindow.start) : ticks(windowStart);
    const end = exactWindow ? parseExactInstant(exactWindow.end) : ticks(windowEnd);
    const gaps: Interval[] = [];
    let cursor = start;
    for (const b of mergeIntervals(busy).map(intervalTicks)) {
      if (b.end <= start || b.start >= end) continue;
      const left = b.start > start ? b.start : start;
      if (left > cursor) gaps.push(fromTicks(cursor, left, true));
      const right = b.end < end ? b.end : end;
      if (right > cursor) cursor = right;
    }
    if (cursor < end) gaps.push(fromTicks(cursor, end, true));
    return gaps;
  }
  const gaps: Interval[] = [];
  let cursor = windowStart;
  for (const b of mergeIntervals(busy)) {
    if (b.end <= windowStart || b.start >= windowEnd) continue;
    const bStart = Math.max(b.start, windowStart);
    if (bStart > cursor) gaps.push({ start: cursor, end: bStart });
    cursor = Math.max(cursor, Math.min(b.end, windowEnd));
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
  return gaps;
}

export type WorkingHours = { startHour: number; endHour: number }; // local hours, e.g. 9–17

/**
 * Clip a gap to the working-hours window of each day it spans, in the FAMILY's
 * zone.
 *
 * This was the sharpest instance of the server-midnight defect in the
 * repository. `WorkingHours` is documented as "local hours, e.g. 9–17" and
 * `setHours(hours.startHour, ...)` applied them on the HOST — so on a UTC host
 * a Californian family's 9–17 working window was proposed as 09:00–17:00 UTC,
 * which is 01:00–09:00 for them. The AI schedule route suggested meetings in the
 * middle of the night and called the actual working day busy.
 *
 * Iterating by day KEY rather than `+= DAY_MS` matters for the same reason it
 * does above: adding 24 hours across a DST boundary lands an hour off the local
 * midnight and drags every subsequent day with it.
 */
function clipToWorkingHours(gap: Interval, hours: WorkingHours, tz: string): Interval[] {
  const out: Interval[] = [];
  let dayKey = dayKeyInTz(new Date(gap.start), tz);
  // Bounded like `dayKeysBetween` in lib/services/scope.ts: a search window is
  // days or weeks, and a bound means a bug here cannot become a hung request.
  for (let guard = 0; guard < 400; guard += 1) {
    const day = zonedDayBoundsMs(dayKey, tz);
    if (gap.exactInterval ? ticks(day.start) >= intervalTicks(gap).end : day.start >= gap.end) break;
    const open = zonedTimeMs(dayKey, hours.startHour, 0, tz);
    const close = zonedTimeMs(dayKey, hours.endHour, 0, tz);
    const s = Math.max(gap.start, open);
    const e = Math.min(gap.end, close);
    if (gap.exactInterval) {
      const exact = intervalTicks(gap), left = ticks(open), right = ticks(close);
      const start = exact.start > left ? exact.start : left, end = exact.end < right ? exact.end : right;
      if (end > start) out.push(fromTicks(start, end, true));
    } else if (e > s) out.push({ start: s, end: e });
    dayKey = addDaysToDayKey(dayKey, 1);
  }
  return out;
}

export type SlotOptions = {
  windowStart: number;
  windowEnd: number;
  durationMin: number;
  /** The family's IANA zone. Required: `workingHours` and all-day blocking are
   *  both LOCAL concepts, and a default here would silently mean the host. */
  tz: string;
  workingHours?: WorkingHours;
  /** Only consider these contexts as "busy" (default: all). */
  contexts?: CalendarContext[];
  maxSuggestions?: number;
  /** Snap slot starts to this minute granularity (default 15). */
  granularityMin?: number;
};

/** Convert the decimal value supplied in minutes without floating multiplication. */
function minuteTicks(value: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? '';
  let numerator = BigInt(match[1] + fraction) * 60_000_000_000n;
  const power = Number(match[3] ?? 0) - fraction.length;
  if (power >= 0) return numerator * 10n ** BigInt(power);
  const denominator = 10n ** BigInt(-power);
  if (numerator % denominator !== 0n) return null;
  numerator /= denominator;
  return numerator > 0n ? numerator : null;
}
/**
 * Find free slots of `durationMin` across the combined busy time of all members.
 * Each member's events contribute to the shared busy set, so a slot is one where
 * everyone is free. Returns slot start/end intervals, soonest first.
 */
export function findFreeSlots(allEvents: BusyEvent[], opts: SlotOptions): Interval[] {
  const duration = minuteTicks(opts.durationMin), granularity = minuteTicks(opts.granularityMin ?? 15);
  if (duration === null || granularity === null) return [];
  const durationMs = Number(duration / 1_000_000n);
  const granMs = Number(granularity / 1_000_000n);
  const busy = busyIntervals(allEvents, opts.contexts, opts.tz);
  let gaps = freeGaps(busy, opts.windowStart, opts.windowEnd);
  if (opts.workingHours) gaps = gaps.flatMap((g) => clipToWorkingHours(g, opts.workingHours!, opts.tz));

  const slots: Interval[] = [];
  const now = Date.now();
  for (const g of gaps) {
    if (g.exactInterval || duration % 1_000_000n !== 0n || granularity % 1_000_000n !== 0n) {
      const exact = intervalTicks(g);
      let start = exact.start > ticks(now) ? exact.start : ticks(now);
      const remainder = (start % granularity + granularity) % granularity;
      if (remainder) start += granularity - remainder;
      while (start + duration <= exact.end) {
        slots.push(fromTicks(start, start + duration, start % 1_000_000n !== 0n || duration % 1_000_000n !== 0n));
        if (slots.length >= (opts.maxSuggestions ?? 6)) return slots;
        start += granularity;
      }
      continue;
    }
    // Snap the first candidate start up to the granularity grid and to "now".
    let start = Math.max(g.start, now);
    const rem = start % granMs;
    if (rem !== 0) start += granMs - rem;
    while (start + durationMs <= g.end) {
      slots.push({ start, end: start + durationMs });
      if (slots.length >= (opts.maxSuggestions ?? 6)) return slots;
      start += granMs;
    }
  }
  return slots;
}
