// lib/home/home-data.ts — small PURE helpers for the Home dashboard (finance
// roll-up, member taglines, week strip). DOM-free + unit-tested so the page can
// stay a thin Supabase reader.

import type { MemberRole } from '@/lib/constants/roles';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';
import { ageOn } from '@/lib/utils/birthday';
import { addDaysToDayKey, weekStartDayKey } from '@/lib/services/scope';

// ── Finances ────────────────────────────────────────────────────────────────
export type HomeTxn = { type: string; amount: number; date: string };
export type MonthFinances = { income: number; expenses: number; remaining: number };

/**
 * Roll up the current calendar month's transactions into income / expenses /
 * remaining. Expenses are summed by magnitude (stored as either sign). Rows with
 * an unparseable date, or outside the current month, are ignored.
 */
export function summarizeMonthFinances(txns: HomeTxn[], now: Date): MonthFinances {
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let income = 0;
  let expenses = 0;
  for (const t of txns ?? []) {
    const dateKey = /^(\d{4}-\d{2})-\d{2}(?:$|T)/.exec(t.date)?.[1];
    if (dateKey !== monthKey) continue;
    const amt = Number(t.amount);
    if (!Number.isFinite(amt)) continue;
    if (t.type === 'income') income += Math.abs(amt);
    else if (t.type === 'expense') expenses += Math.abs(amt);
  }
  return { income, expenses, remaining: income - expenses };
}

/**
 * Dollars with thousands separators, e.g. 2767.6 → "$2,767.60".
 *
 * This one carried a second defect behind the hardcoded locale: it prefixed the
 * "$" BY HAND and only localised the digits. Handing it a European locale that way
 * would have produced "$2.767,60" — the symbol in the American position with
 * German separators, which is a currency notation nobody uses. `style: 'currency'`
 * puts the symbol where the locale puts it ("2.767,60 $") and is what the rest of
 * the app already does.
 */
export function usd(amount: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount ?? 0);
}

// ── Family members ────────────────────────────────────────────────────────────
const SHORT_ROLE: Record<MemberRole, string> = {
  parent: 'Parent', adult: 'Adult', teen: 'Teen', child: 'Child', caregiver: 'Caregiver', guest: 'Guest',
};

/** Whole-year age from an ISO birthday, or null if missing/unparseable. */
export function ageFromBirthday(birthday: string | null | undefined, now: Date): number | null {
  const age = ageOn(birthday, now);
  return age !== null && age >= 0 && age < 150 ? age : null;
}

/**
 * The small caption under a member's avatar: "Me" for the signed-in user, an age
 * ("12 yrs") for young members with a birthday, else a short role label.
 */
export function memberTagline(
  m: { user_id: string | null; role: string; birthday: string | null },
  currentUserId: string,
  now: Date,
): string {
  if (m.user_id && m.user_id === currentUserId) return 'Me';
  const age = ageFromBirthday(m.birthday, now);
  if (age !== null && age < 25) return `${age} yrs`;
  return SHORT_ROLE[m.role as MemberRole] ?? 'Member';
}

// ── Week strip (meal planner) ─────────────────────────────────────────────────
export type WeekDay = { date: string; dow: string; dom: number; isToday: boolean };

/**
 * A Mon→Sun strip for the week containing `todayKey` (each day's ISO date,
 * label, today flag).
 *
 * Takes the family's DAY KEY rather than a `Date`, which is what removes the
 * zone question from this function instead of answering it wrongly. It used to
 * take `now` and call `setHours(0, 0, 0, 0)` — the HOST's midnight — while its
 * one caller had already resolved the family's day two lines above and passed
 * the raw clock in anyway. On a UTC host that strip highlighted tomorrow from
 * 17:00 onward for a Californian household.
 *
 * Built by day-key arithmetic rather than by adding days to a Date, so the
 * 23- and 25-hour DST days cannot shift a column.
 */
export function weekStrip(todayKey: string): WeekDay[] {
  const startKey = weekStartDayKey(todayKey);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysToDayKey(startKey, i);
    return { date, dow: labels[i], dom: Number(date.slice(8, 10)), isToday: date === todayKey };
  });
}

/** Local YYYY-MM-DD (matches a Postgres `date` column, no timezone shift). */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}
