// lib/moments/grouping.ts — bucket moments by how soon they are, so the Moments
// page reads as a calm, scannable timeline (Today / Tomorrow / This week / Later)
// instead of one long undifferentiated grid. Pure + tested; the view groups its
// already-built moment list by each event's start.

import { allDayDate } from '@/lib/calendar/day';
import { daysBetweenDayKeys } from '@/lib/moments/birthdays';
import { dayKeyIn } from '@/lib/time/zoned';

export type MomentBucket = 'today' | 'tomorrow' | 'this-week' | 'later';

export const BUCKET_LABEL: Record<MomentBucket, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  'this-week': 'This week',
  later: 'Later',
};

/** Fixed display order — soonest first. */
export const BUCKET_ORDER: MomentBucket[] = ['today', 'tomorrow', 'this-week', 'later'];

/**
 * Whose day the buckets are counted on. `timeZone` is the FAMILY's zone: "today"
 * is the family's calendar day, the same day the card's own label
 * (`momentWhen`) uses. `allDay` marks a calendar DATE: an all-day row is stored
 * at UTC midnight (lib/calendar/day.ts), so it is filed under the date it
 * names, never under the day that instant falls on somewhere west of Greenwich.
 */
export type MomentBucketOptions = { allDay?: boolean | null; timeZone?: string };

/** A Date's own (runtime-local) calendar day — the day only when no family zone is given. */
function runtimeDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which bucket a start time falls into, relative to `now` (whole-day math
 * between day keys). Pass the family's `timeZone`, and `allDay` for a row that
 * names a date; without a zone a timed start and `now` are read on the runtime's
 * calendar.
 */
export function momentBucket(startsAtISO: string, now: Date = new Date(), opts: MomentBucketOptions = {}): MomentBucket {
  const { allDay, timeZone } = opts;
  let startKey: string;
  if (allDay) {
    startKey = allDayDate(startsAtISO);
  } else {
    const d = new Date(startsAtISO);
    if (Number.isNaN(d.getTime())) return 'later';
    startKey = timeZone ? dayKeyIn(d, timeZone) : runtimeDayKey(d);
  }
  if (Number.isNaN(now.getTime())) return 'later';
  const todayKey = timeZone ? dayKeyIn(now, timeZone) : runtimeDayKey(now);
  const dayDiff = daysBetweenDayKeys(todayKey, startKey);
  if (dayDiff === null) return 'later';
  if (dayDiff <= 0) return 'today';   // today or already-started-today (all-day birthdays)
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff <= 7) return 'this-week';
  return 'later';
}

/**
 * Group an ordered list of items by their start time into the non-empty buckets,
 * preserving input order within each. Returns sections in BUCKET_ORDER, skipping
 * any that are empty, so the caller renders exactly the headers it needs.
 * `opts.timeZone` is the family's zone and `opts.allDay` says which items name
 * a date (see `MomentBucketOptions`). `label` is the English source word; a
 * page renders the header from its catalogue, keyed by `bucket`.
 */
export function groupMoments<T>(
  items: T[],
  startsAt: (item: T) => string,
  now: Date = new Date(),
  opts: { timeZone?: string; allDay?: (item: T) => boolean | null | undefined } = {},
): { bucket: MomentBucket; label: string; items: T[] }[] {
  const map = new Map<MomentBucket, T[]>();
  for (const it of items ?? []) {
    const b = momentBucket(startsAt(it), now, { timeZone: opts.timeZone, allDay: opts.allDay?.(it) });
    const arr = map.get(b) ?? [];
    arr.push(it);
    map.set(b, arr);
  }
  return BUCKET_ORDER
    .filter((b) => (map.get(b)?.length ?? 0) > 0)
    .map((b) => ({ bucket: b, label: BUCKET_LABEL[b], items: map.get(b) as T[] }));
}
