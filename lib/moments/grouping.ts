// lib/moments/grouping.ts — bucket moments by how soon they are, so the Moments
// page reads as a calm, scannable timeline (Today / Tomorrow / This week / Later)
// instead of one long undifferentiated grid. Pure + tested; the view groups its
// already-built moment list by each event's start.

export type MomentBucket = 'today' | 'tomorrow' | 'this-week' | 'later';

export const BUCKET_LABEL: Record<MomentBucket, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  'this-week': 'This week',
  later: 'Later',
};

/** Fixed display order — soonest first. */
export const BUCKET_ORDER: MomentBucket[] = ['today', 'tomorrow', 'this-week', 'later'];

/** Which bucket a start time falls into, relative to `now` (whole-day math). */
export function momentBucket(startsAtISO: string, now: Date = new Date()): MomentBucket {
  const d = new Date(startsAtISO);
  if (Number.isNaN(d.getTime())) return 'later';
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.round((startDay - today) / 86400000);
  if (dayDiff <= 0) return 'today';   // today or already-started-today (all-day birthdays)
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff <= 7) return 'this-week';
  return 'later';
}

/**
 * Group an ordered list of items by their start time into the non-empty buckets,
 * preserving input order within each. Returns sections in BUCKET_ORDER, skipping
 * any that are empty, so the caller renders exactly the headers it needs.
 */
export function groupMoments<T>(
  items: T[],
  startsAt: (item: T) => string,
  now: Date = new Date(),
): { bucket: MomentBucket; label: string; items: T[] }[] {
  const map = new Map<MomentBucket, T[]>();
  for (const it of items ?? []) {
    const b = momentBucket(startsAt(it), now);
    const arr = map.get(b) ?? [];
    arr.push(it);
    map.set(b, arr);
  }
  return BUCKET_ORDER
    .filter((b) => (map.get(b)?.length ?? 0) > 0)
    .map((b) => ({ bucket: b, label: BUCKET_LABEL[b], items: map.get(b) as T[] }));
}
