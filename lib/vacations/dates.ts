// Vacation date helpers — pure, unit-tested.

const DAY = 86_400_000;

const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole days until a trip starts. Negative once it has started/passed. null if no date. */
export function daysUntil(startDate: string | null | undefined, today: Date = new Date()): number | null {
  if (!startDate) return null;
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

/** Inclusive list of YYYY-MM-DD strings between start and end (capped to maxDays). */
export function dateRange(start: string, end: string, maxDays = 60): string[] {
  const a = new Date(start + 'T00:00:00'), b = new Date(end + 'T00:00:00');
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return [];
  const out: string[] = [];
  for (let t = a.getTime(); t <= b.getTime() && out.length < maxDays; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Human countdown label: "in 12 days", "Today", "Started", "5 days ago". */
export function countdownLabel(startDate: string | null | undefined, today: Date = new Date()): string {
  const d = daysUntil(startDate, today);
  if (d === null) return 'No dates yet';
  if (d > 1) return `in ${d} days`;
  if (d === 1) return 'Tomorrow';
  if (d === 0) return 'Today';
  if (d === -1) return 'Started yesterday';
  return `${-d} days ago`;
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
