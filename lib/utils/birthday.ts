import { parseISO } from 'date-fns';

// A birthday is a calendar date ('2015-03-04'), not an instant. `new Date()`
// reads a date-only string as UTC midnight, which everywhere west of Greenwich
// is the evening before: read back through local getters, a child's age turned
// over, and "Today" showed on the family page, a day early on every US device,
// and the printed check-in sheet gave the wrong date of birth. parseISO reads it
// as that day in local time, so the local getters below are right everywhere.

/** The birthday as local midnight on that calendar day, or null if missing or unparseable. */
export function parseBirthday(birthday: string | null | undefined): Date | null {
  if (!birthday) return null;
  const b = parseISO(birthday);
  return Number.isNaN(b.getTime()) ? null : b;
}

/** Whole years on `now`'s local calendar day, or null. The caller bounds it. */
export function ageOn(birthday: string | null | undefined, now: Date): number | null {
  const b = parseBirthday(birthday);
  if (!b) return null;
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

/** The next time the birthday comes round on or after `now`'s local day, and the age it brings. */
export function nextBirthday(birthday: string | null | undefined, now: Date): { date: Date; inDays: number; turning: number } | null {
  const b = parseBirthday(birthday);
  if (!b) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (next < today) next = new Date(now.getFullYear() + 1, b.getMonth(), b.getDate());
  const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
  const turning = next.getFullYear() - b.getFullYear();
  return { date: next, inDays, turning };
}
