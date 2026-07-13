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

export type Interval = { start: number; end: number }; // epoch ms
export type BusyEvent = {
  starts_at: string;
  ends_at?: string | null;
  all_day?: boolean | null;
  context?: CalendarContext | null;
  assignee_id?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Convert events into busy intervals, optionally filtered to certain contexts. */
export function busyIntervals(events: BusyEvent[], contexts?: CalendarContext[]): Interval[] {
  const out: Interval[] = [];
  for (const e of events) {
    if (contexts && contexts.length > 0 && !contexts.includes((e.context ?? 'family'))) continue;
    const start = new Date(e.starts_at).getTime();
    if (Number.isNaN(start)) continue;
    let end: number;
    if (e.all_day) {
      // All-day events block the whole local day.
      const d = new Date(start);
      d.setHours(0, 0, 0, 0);
      const dayStart = d.getTime();
      end = dayStart + DAY_MS;
      out.push({ start: dayStart, end });
      continue;
    }
    const rawEnd = e.ends_at ? new Date(e.ends_at).getTime() : start + 30 * 60 * 1000;
    end = Number.isNaN(rawEnd) || rawEnd <= start ? start + 30 * 60 * 1000 : rawEnd;
    out.push({ start, end });
  }
  return mergeIntervals(out);
}

/** Merge overlapping/adjacent intervals into a sorted, non-overlapping set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
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
export function freeGaps(busy: Interval[], windowStart: number, windowEnd: number): Interval[] {
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

/** Clip a gap to the working-hours window of each day it spans. */
function clipToWorkingHours(gap: Interval, hours: WorkingHours): Interval[] {
  const out: Interval[] = [];
  const startDay = new Date(gap.start); startDay.setHours(0, 0, 0, 0);
  for (let d = startDay.getTime(); d < gap.end; d += DAY_MS) {
    const dayOpen = new Date(d); dayOpen.setHours(hours.startHour, 0, 0, 0);
    const dayClose = new Date(d); dayClose.setHours(hours.endHour, 0, 0, 0);
    const s = Math.max(gap.start, dayOpen.getTime());
    const e = Math.min(gap.end, dayClose.getTime());
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

export type SlotOptions = {
  windowStart: number;
  windowEnd: number;
  durationMin: number;
  workingHours?: WorkingHours;
  /** Only consider these contexts as "busy" (default: all). */
  contexts?: CalendarContext[];
  maxSuggestions?: number;
  /** Snap slot starts to this minute granularity (default 15). */
  granularityMin?: number;
};

/**
 * Find free slots of `durationMin` across the combined busy time of all members.
 * Each member's events contribute to the shared busy set, so a slot is one where
 * everyone is free. Returns slot start/end intervals, soonest first.
 */
export function findFreeSlots(allEvents: BusyEvent[], opts: SlotOptions): Interval[] {
  const durationMs = opts.durationMin * 60 * 1000;
  const granMs = (opts.granularityMin ?? 15) * 60 * 1000;
  const busy = busyIntervals(allEvents, opts.contexts);
  let gaps = freeGaps(busy, opts.windowStart, opts.windowEnd);
  if (opts.workingHours) gaps = gaps.flatMap((g) => clipToWorkingHours(g, opts.workingHours!));

  const slots: Interval[] = [];
  const now = Date.now();
  for (const g of gaps) {
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
