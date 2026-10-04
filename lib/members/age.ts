// lib/members/age.ts — shared "how old is this member today" helper.

/**
 * Whole years old on `today` for a YYYY-MM-DD birthday (null when unknown/invalid).
 *
 * Reads `today`'s LOCAL calendar parts, which in a browser is the reader's own
 * day and is right. On a server that is the HOST's day — the UTC host that
 * renders a page or answers a service call is on tomorrow from 5pm in
 * California — so a server caller uses `ageOnDay` with the family's day key.
 */
export function ageOn(birthday: string | null | undefined, today: Date): number | null {
  if (!birthday) return null;
  const b = new Date(`${birthday.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  let age = today.getFullYear() - b.getFullYear();
  const beforeBirthday = today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  return Math.max(0, age);
}

/**
 * Whole years old on the day `todayKey` names (YYYY-MM-DD) — day key in,
 * number out, no instant and no zone anywhere. A child whose birthday is today
 * in Los Angeles turned a year older at the family's midnight, not at
 * Greenwich's seven hours earlier, and not at Greenwich's tomorrow either.
 */
export function ageOnDay(birthday: string | null | undefined, todayKey: string): number | null {
  if (!birthday) return null;
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayKey);
  if (!b || !t) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return Math.max(0, age);
}
