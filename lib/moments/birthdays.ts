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

/** The next occurrence (>= today, local midnight) of a month/day, this year or next. */
export function nextBirthdayDate(birthday: string, now: Date = new Date()): Date | null {
  const p = parseBirthday(birthday);
  if (!p) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), p.month - 1, p.day);
  if (d.getTime() < today.getTime()) d = new Date(now.getFullYear() + 1, p.month - 1, p.day);
  return d;
}

/** Whole days from `now`'s date to a target date (0 = today). */
export function daysUntil(target: Date, now: Date = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
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
        starts_at: next.toISOString(),
        all_day: true,
        description: 'Family birthday',
      },
      days,
    });
  }
  return out.sort((a, b) => a.days - b.days).map((x) => x.event);
}
