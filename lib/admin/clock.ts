/**
 * THE ADMIN SURFACES ANSWER IN ONE EXPLICIT ZONE.
 *
 * They serve operators, not a family, so there is no family zone to read — and
 * what the pages had grown instead was the HOST's: `new Date(y, m, 1)` for a
 * month boundary and a `toLocale*String` with no `timeZone` for its label both
 * resolve in whatever zone the machine rendering the page runs in. On Vercel
 * that is UTC and reads like a convention; the same page rendered on a laptop
 * in California bucketed "this month" from a different midnight and labelled
 * a 1 May row "Apr", and the two disagreed about which month a subscription
 * created at 23:30 on the 31st belongs to.
 *
 * The admin digest already dates itself in an explicit UTC for the same reason
 * (app/api/cron/admin-digest/route.ts). These helpers give the pages the same
 * answer: `Date.UTC` here IS that zone, and every label that goes with a
 * window names it (`timeZone: ADMIN_ZONE`), so the page reads the same from
 * every host. Guarded by tests/an-admin-page-renders-an-explicit-zone.test.ts.
 */
export const ADMIN_ZONE = 'UTC';

export type Window = { start: number; end: number };

/** The last `count` calendar months in ADMIN_ZONE, oldest first, ending with the month `now` is in. */
export function lastUtcMonths(count: number, now: Date = new Date()): Window[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    return { start: Date.UTC(y, m - back, 1), end: Date.UTC(y, m - back + 1, 1) };
  });
}

/** The last `count` whole days in ADMIN_ZONE, oldest first, ending with the day `now` is in. */
export function lastUtcDays(count: number, now: Date = new Date()): Window[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    return { start: Date.UTC(y, m, d - back), end: Date.UTC(y, m, d - back + 1) };
  });
}

/** The first instant of the month `now` is in, in ADMIN_ZONE, as an ISO string for a `created_at >=` filter. */
export function utcMonthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Whether an ISO instant falls in `[start, end)`. An unparseable value is in no window. */
export function inWindow(iso: string, w: Window): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= w.start && t < w.end;
}
