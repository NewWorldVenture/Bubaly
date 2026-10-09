// lib/schedule/zoned.ts — family-zone wall-clock arithmetic for PURE engines.
//
// `lib/services/scope.ts` owns the same arithmetic for the service layer, but
// it imports `server-only`, so an engine that must also run in a unit test or
// a browser cannot reach it. These helpers keep the identical `YYYY-MM-DD` day
// key shape (and the identical two-pass DST resolution) so a day key computed
// here compares equal to one computed there. No clock reads: every function
// takes the instant it should resolve.

/** The family's calendar day for an instant, as `YYYY-MM-DD`; null when unparseable. */
export function dayKeyInZone(ms: number, tz: string): string | null {
  if (!Number.isFinite(ms)) return null;
  const instant = new Date(ms);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    if (get('era') !== 'AD') return null;
    const key = `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  } catch {
    const year = instant.getUTCFullYear();
    return year >= 1 && year <= 9999 ? instant.toISOString().slice(0, 10) : null;
  }
}

/** UTC offset of `tz` at `ms`, in milliseconds (DST-correct without a tz database). */
/** Preserve Gregorian years 00–99 during UTC field reconstruction. */
function utcFieldsMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const value = new Date(0);
  value.setUTCFullYear(year, month, day);
  value.setUTCHours(hour, minute, second, 0);
  return value.getTime();
}

function tzOffsetMs(ms: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);
    const year = parts.find((p) => p.type === 'era')?.value === 'BC' ? 1 - get('year') : get('year');
    const asUtc = utcFieldsMs(year, get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Number.isFinite(asUtc) ? asUtc - ms : 0;
  } catch {
    return 0;
  }
}

/** The instant at which local wall-clock `dayKey` `hh:mm` occurs in `tz` (NaN when unparseable). */
export function zonedTimeMs(dayKey: string, hour: number, minute: number, tz: string): number {
  const pad = (n: number) => String(n).padStart(2, '0');
  const guess = Date.parse(`${dayKey}T${pad(hour)}:${pad(minute)}:00Z`);
  if (!Number.isFinite(guess)) return Number.NaN;
  const firstPass = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(firstPass, tz);
}

/** "6:00 PM" for an instant, on the family's wall clock. Empty when unparseable. */
export function clockInZone(ms: number, tz: string): string {
  if (!Number.isFinite(ms)) return '';
  const instant = new Date(ms);
  if (!Number.isFinite(instant.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(instant);
  } catch {
    return `${String(instant.getUTCHours()).padStart(2, '0')}:${String(instant.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Today on the family's wall, as `YYYY-MM-DD`.
 *
 * The form this replaces — `new Date().toISOString().slice(0, 10)` — answers
 * the day at Greenwich, which is a different day from the family's for a large
 * and predictable slice of every day (7h/day in Los Angeles, 10h/day in
 * Sydney). Written into a DATE column that difference persists: a parent in
 * Los Angeles logging an expense at 18:30 on Sunday files it against Monday.
 *
 * Takes `now` so callers can pin it in a test; reads the clock otherwise.
 */
export function todayInZone(tz: string, now: number = Date.now()): string {
  return dayKeyInZone(now, tz) ?? new Date(now).toISOString().slice(0, 10);
}
