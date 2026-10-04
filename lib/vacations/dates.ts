// Vacation date helpers — pure, unit-tested.

const DAY = 86_400_000;

const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Whole days until a trip starts. Negative once it has started/passed. null if
 * no date.
 *
 * `today` is the FAMILY's day key (YYYY-MM-DD) from a server caller — a Date
 * there is the HOST's calendar, tomorrow from 5pm in California on a UTC host —
 * or a Date from a browser, whose local midnight is the reader's own.
 */
export function daysUntil(startDate: string | null | undefined, today: Date | string = new Date()): number | null {
  if (!startDate) return null;
  if (typeof today === 'string') {
    const a = Date.parse(`${startDate}T00:00:00Z`);
    const b = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((a - b) / DAY);
  }
  const start = new Date(startDate + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return null;
  return Math.round((start.getTime() - atMidnight(today).getTime()) / DAY);
}

/** Trip length in nights (end - start). null if dates missing/invalid. */
export function tripNights(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const a = new Date(start + 'T00:00:00'), b = new Date(end + 'T00:00:00');
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / DAY));
}

/**
 * Inclusive list of YYYY-MM-DD strings between start and end (capped to maxDays).
 *
 * `start` and `end` are DATE values — calendar days, not instants — so the walk
 * happens entirely in UTC and the keys come back exactly as they went in. The
 * previous anchor was LOCAL midnight (`new Date(start + 'T00:00:00')`) read back
 * with `toISOString()`, which re-expresses that local moment at Greenwich: east
 * of Greenwich every key slid one day BACK (local midnight 10 Oct in Tokyo is
 * 9 Oct 15:00Z), so a 10–17 Oct trip materialised days 9–16 Oct and nothing was
 * ever stored for the last day. At or west of Greenwich it happened to land on
 * the right day, which is why CI (UTC and America/Los_Angeles) never saw it.
 * UTC days are always exactly 24h, so stepping by DAY here is DST-proof too.
 */
export function dateRange(start: string, end: string, maxDays = 60): string[] {
  const a = Date.parse(start + 'T00:00:00Z'), b = Date.parse(end + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return [];
  const out: string[] = [];
  for (let t = a; t <= b && out.length < maxDays; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Human countdown label in the reader's language: "in 12 days", "Today",
 * "Started yesterday", "5 days ago". It returned English sentences, which the
 * trip header, the trip list and the overview showed in every locale.
 * Audit LAYOUT-002.
 */
export function countdownLabel(
  tr: (key: string, params?: Record<string, string | number>) => string,
  startDate: string | null | undefined,
  today: Date | string = new Date(),
): string {
  const d = daysUntil(startDate, today);
  if (d === null) return tr('tripCountdown.noDatesYet');
  if (d > 1) return tr('tripCountdown.inDays', { count: d });
  if (d === 1) return tr('tripCountdown.tomorrow');
  if (d === 0) return tr('tripCountdown.today');
  if (d === -1) return tr('tripCountdown.startedYesterday');
  return tr('tripCountdown.daysAgo', { count: -d });
}

/** True when today falls within [start, end] inclusive. */
export function isActive(start: string | null | undefined, end: string | null | undefined, today: Date = new Date()): boolean {
  if (!start) return false;
  const s = daysUntil(start, today);
  if (s === null || s > 0) return false;
  if (!end) return s === 0;
  const e = daysUntil(end, today);
  return e !== null && e >= 0;
}
