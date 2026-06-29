// lib/home/home-data.ts — small PURE helpers for the Home dashboard (finance
// roll-up, member taglines, week strip). DOM-free + unit-tested so the page can
// stay a thin Supabase reader.

import type { MemberRole } from '@/lib/constants/roles';

// ── Finances ────────────────────────────────────────────────────────────────
export type HomeTxn = { type: string; amount: number; date: string };
export type MonthFinances = { income: number; expenses: number; remaining: number };

/**
 * Roll up the current calendar month's transactions into income / expenses /
 * remaining. Expenses are summed by magnitude (stored as either sign). Rows with
 * an unparseable date, or outside the current month, are ignored.
 */
export function summarizeMonthFinances(txns: HomeTxn[], now: Date): MonthFinances {
  const y = now.getFullYear();
  const m = now.getMonth();
  let income = 0;
  let expenses = 0;
  for (const t of txns ?? []) {
    const d = new Date(t.date);
    if (Number.isNaN(d.getTime()) || d.getFullYear() !== y || d.getMonth() !== m) continue;
    const amt = Number(t.amount);
    if (!Number.isFinite(amt)) continue;
    if (t.type === 'income') income += Math.abs(amt);
    else if (t.type === 'expense') expenses += Math.abs(amt);
  }
  return { income, expenses, remaining: income - expenses };
}

/** Whole dollars with thousands separators, e.g. 2767.6 → "$2,767.60". */
export function usd(amount: number): string {
  return `$${(amount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Family members ────────────────────────────────────────────────────────────
const SHORT_ROLE: Record<MemberRole, string> = {
  parent: 'Parent', adult: 'Adult', teen: 'Teen', child: 'Child', caregiver: 'Caregiver', guest: 'Guest',
};

/** Whole-year age from an ISO birthday, or null if missing/unparseable. */
export function ageFromBirthday(birthday: string | null | undefined, now: Date): number | null {
  if (!birthday) return null;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  let age = now.getFullYear() - b.getFullYear();
  const md = now.getMonth() - b.getMonth();
  if (md < 0 || (md === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 150 ? age : null;
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

/** A Mon→Sun strip for the week containing `now` (each day's ISO date, label, today flag). */
export function weekStrip(now: Date): WeekDay[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // ISO week: Monday start. JS getDay(): 0=Sun..6=Sat.
  const dow = (start.getDay() + 6) % 7; // 0=Mon..6=Sun
  start.setDate(start.getDate() - dow);
  const todayIso = isoDate(now);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = isoDate(d);
    return { date: iso, dow: labels[i], dom: d.getDate(), isToday: iso === todayIso };
  });
}

/** Local YYYY-MM-DD (matches a Postgres `date` column, no timezone shift). */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}
