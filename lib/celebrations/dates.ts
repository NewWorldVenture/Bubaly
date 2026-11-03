// Pure celebration/anniversary date logic — unit tested, no dependencies.

export type CelebrationKind = 'birthday' | 'anniversary' | 'holiday' | 'other';

export type CelebrationInput = {
  id: string;
  kind: CelebrationKind;
  title: string;
  /** A date string; we only use the month/day for the annual recurrence. */
  date: string;
  memberId?: string | null;
  color?: string | null;
};

export type Celebration = CelebrationInput & {
  /** Next occurrence as an ISO date (yyyy-mm-dd, local). */
  nextDate: string;
  daysUntil: number;
  /** Years since the original date at the next occurrence, when computable. */
  turning: number | null;
};

function parseMonthDay(date: string): { y: number | null; m: number; d: number } | null {
  // Accepts "YYYY-MM-DD" or "MM-DD".
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (full) return { y: Number(full[1]), m: Number(full[2]), d: Number(full[3]) };
  const md = /^(\d{2})-(\d{2})$/.exec(date);
  if (md) return { y: null, m: Number(md[1]), d: Number(md[2]) };
  return null;
}

/** Days until the next annual occurrence of a date (0 = today). */
export function daysUntilNext(date: string, from: Date = new Date()): number | null {
  const p = parseMonthDay(date);
  if (!p) return null;
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next = new Date(today.getFullYear(), p.m - 1, p.d);
  if (next < today) next = new Date(today.getFullYear() + 1, p.m - 1, p.d);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

/**
 * Days until the next annual occurrence of a date, counted FROM A DAY KEY
 * (0 = today) — the server surface's `daysUntilNext`.
 *
 * `daysUntilNext` reads `from`'s local calendar parts, which on a page a UTC
 * host renders is Greenwich's today: from 5pm in California the grandparent
 * portal counted every birthday and family date from tomorrow, so today's was
 * "in 364 days". The caller hands in `dayKeyInTz(now, family.timezone)` and no
 * instant is involved. An impossible date (29 Feb in a common year) normalises
 * forward to 1 Mar, as `new Date(y, m - 1, d)` always has.
 */
export function daysUntilNextOn(date: string, todayKey: string): number | null {
  const at = nextOnKey(date, todayKey);
  return at ? Math.round((at.next - at.today) / 86400000) : null;
}

/**
 * The day a date next falls on, on or after the day key `todayKey`, as a day
 * key: the day `daysUntilNextOn` counts to, normalised the same way (29 Feb in
 * a common year is 1 Mar).
 *
 * A surface that prints a coming celebration prints THIS, not the stored date.
 * The stored date is the year it began, so its weekday is that year's: the
 * grandparent portal read "Sun, Nov 20" for a 2016 birthday that falls on a
 * Friday in 2026.
 */
export function nextOccurrenceOn(date: string, todayKey: string): string | null {
  const at = nextOnKey(date, todayKey);
  if (!at) return null;
  // Date.UTC is zone-free calendar arithmetic here, read back with getUTC*.
  const d = new Date(at.next);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** `todayKey` and the next occurrence of `date` on or after it, as UTC-midnight milliseconds. */
function nextOnKey(date: string, todayKey: string): { today: number; next: number } | null {
  const p = parseMonthDay(date);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayKey);
  if (!p || !t) return null;
  const today = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  let next = Date.UTC(Number(t[1]), p.m - 1, p.d);
  if (next < today) next = Date.UTC(Number(t[1]) + 1, p.m - 1, p.d);
  if (!Number.isFinite(today) || !Number.isFinite(next)) return null;
  return { today, next };
}

/** Resolve a list of inputs into upcoming celebrations within `withinDays`. */
export function upcomingCelebrations(
  items: CelebrationInput[],
  withinDays = 60,
  from: Date = new Date(),
): Celebration[] {
  const out: Celebration[] = [];
  for (const it of items) {
    const p = parseMonthDay(it.date);
    if (!p) continue;
    const days = daysUntilNext(it.date, from)!;
    if (days > withinDays) continue;
    const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    let next = new Date(today.getFullYear(), p.m - 1, p.d);
    if (next < today) next = new Date(today.getFullYear() + 1, p.m - 1, p.d);
    const turning = p.y != null ? next.getFullYear() - p.y : null;
    out.push({
      ...it,
      // Read from `next` itself, which the Date constructor has normalised: a
      // 29 Feb in a common year is 1 Mar, the day `daysUntil` counts to.
      // "2027-02-29" is not a date; its label fell back to a parse at
      // Greenwich and read 28 February west of it.
      nextDate: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`,
      daysUntil: days,
      turning: turning != null && turning > 0 ? turning : null,
    });
  }
  out.sort((a, b) => a.daysUntil - b.daysUntil);
  return out;
}

/** "Today" / "Tomorrow" / "in 5 days" / "in 3 weeks". */
export function countdownLabel(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}
