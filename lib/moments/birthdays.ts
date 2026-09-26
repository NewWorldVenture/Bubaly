// lib/moments/birthdays.ts — turn family birthdays into anticipated "moments".
//
// Birthdays live on family_members.birthday, not on the calendar, so the
// event-driven Moments engine never prepped for them. This pure module projects
// each member's NEXT birthday and, for the ones inside a horizon, emits a
// synthetic MomentEvent so `buildMomentPrep` treats it as a celebration (gift
// reminder, cake→grocery, plan, photos) with zero new prep logic. Tested.

import type { MomentEvent } from '@/lib/moments/prep';

export type BirthdayMember = {
  id: string;
  display_name: string;
  birthday: string | null;
  is_active?: boolean;
};

/** Parse a stored 'YYYY-MM-DD' (or ISO) birthday into {year, month, day}, or null. */
function parseBirthday(value: string): { year: number | null; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: year > 1900 ? year : null, month, day };
}

/**
 * Day index (days since 1970-01-01) of a Date's CALENDAR date, read from its
 * local parts. `Date.UTC` is used only as a zone-free, DST-free calendar
 * arithmetic (never as "this is UTC"): subtracting two of these counts calendar
 * days exactly, where subtracting two local midnights counts 23h or 25h twice a
 * year. It also survives the zones where local midnight does not exist.
 */
function dayIndexOf(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/**
 * A birthday is a DATE, not an instant, so it is emitted as a ZONE-LESS
 * 'YYYY-MM-DDT00:00:00' — never `toISOString()`. `toISOString()` re-expresses
 * local midnight at Greenwich, so east of Greenwich the day walks backwards:
 * midnight 5 July in Asia/Tokyo is 4 July 15:00Z, and every consumer that
 * slices the first ten characters (lib/moments/notify.ts's dedup key) reads the
 * 4th. The parts below come from `d`'s LOCAL fields, which are exactly the
 * calendar date it was constructed from in every zone, so this string is the
 * same in all of them. Consumers that re-parse it get local midnight of that
 * day — the reader's own day, which is what an all-day moment means.
 */
function birthdayDayISO(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00`;
}

/** The next occurrence (>= today, local midnight) of a month/day, this year or next. */
export function nextBirthdayDate(birthday: string, now: Date = new Date()): Date | null {
  const p = parseBirthday(birthday);
  if (!p) return null;
  // `new Date(y, m - 1, d)` also normalizes an impossible date the same way it
  // always has (29 Feb in a common year -> 1 Mar), so that is kept deliberately.
  let d = new Date(now.getFullYear(), p.month - 1, p.day);
  if (dayIndexOf(d) < dayIndexOf(now)) d = new Date(now.getFullYear() + 1, p.month - 1, p.day);
  return d;
}

/**
 * `YYYY-MM-DD` for calendar parts, normalising an impossible date the way
 * `new Date(y, m - 1, d)` always has (29 Feb in a common year -> 1 Mar).
 *
 * `Date.UTC` is used here purely as ZONE-FREE CALENDAR ARITHMETIC, never as
 * "this is UTC" — the parts go in and the same parts come back out, so the
 * answer is identical on every host. The fields are read back with `getUTC*`
 * rather than `toISOString().slice(0, 10)` for the same reason: this file must
 * not grow a spelling of the Greenwich-day bug it exists to avoid.
 */
function dayKeyOfParts(year: number, month: number, day: number): string {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(at.getTime())) return '';
  const y = String(at.getUTCFullYear()).padStart(4, '0');
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The next occurrence of a birthday on or after `todayKey`, as a day key.
 *
 * DAY KEY IN, DAY KEY OUT — no instant is involved anywhere, which is what
 * makes this usable from a server surface that must answer for the FAMILY's
 * day rather than the runtime's. `nextBirthdayDate` above answers the same
 * question against the reader's own local day, which is right for a page
 * rendered in front of that reader and wrong for a background job: on a UTC
 * host it asks Greenwich, and its `Date` result then has to be re-expressed as
 * a day, which walks backwards east of Greenwich (midnight 5 July in
 * Asia/Tokyo is 4 July 15:00Z).
 *
 * Comparison is lexicographic, which is exact for zero-padded ISO day keys,
 * and there is no millisecond arithmetic to be knocked off by a 23- or
 * 25-hour local day.
 */
export function nextBirthdayDayKey(birthday: string, todayKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return null;
  const p = parseBirthday(birthday);
  if (!p) return null;
  const year = Number.parseInt(todayKey.slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  const thisYear = dayKeyOfParts(year, p.month, p.day);
  if (!thisYear) return null;
  return thisYear >= todayKey ? thisYear : (dayKeyOfParts(year + 1, p.month, p.day) || null);
}

/** Whole days from `now`'s date to a target date (0 = today). */
export function daysUntil(target: Date, now: Date = new Date()): number {
  return dayIndexOf(target) - dayIndexOf(now);
}

/**
 * Synthetic MomentEvents for members whose next birthday is within `withinDays`.
 * Sorted soonest first. `turning` age is folded into the title when the birth
 * year is known ("Mia turns 8"), otherwise just "Mia's birthday".
 */
export function upcomingBirthdayEvents(
  members: BirthdayMember[],
  now: Date = new Date(),
  withinDays = 30,
): MomentEvent[] {
  const out: { event: MomentEvent; days: number }[] = [];
  for (const m of members ?? []) {
    if (m.is_active === false || !m.birthday) continue;
    const next = nextBirthdayDate(m.birthday, now);
    if (!next) continue;
    const days = daysUntil(next, now);
    if (days < 0 || days > withinDays) continue;
    const parsed = parseBirthday(m.birthday);
    const first = m.display_name.split(' ')[0] || m.display_name;
    const turning = parsed?.year ? next.getFullYear() - parsed.year : null;
    const title = turning && turning > 0 ? `${first} turns ${turning}` : `${first}'s birthday`;
    out.push({
      event: {
        id: `birthday:${m.id}`,
        title,
        category: 'birthday',
        location: null,
        starts_at: birthdayDayISO(next),
        all_day: true,
        description: 'Family birthday',
      },
      days,
    });
  }
  return out.sort((a, b) => a.days - b.days).map((x) => x.event);
}
