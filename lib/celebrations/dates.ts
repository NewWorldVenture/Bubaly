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
      nextDate: `${next.getFullYear()}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
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
