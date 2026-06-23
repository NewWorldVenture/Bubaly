// Pure immunization helpers — unit tested, no deps.

export const COMMON_VACCINES = [
  'COVID-19', 'Influenza (Flu)', 'Tdap', 'DTaP', 'MMR', 'Varicella (Chickenpox)',
  'Hepatitis A', 'Hepatitis B', 'Polio (IPV)', 'HPV', 'Meningococcal',
  'Pneumococcal', 'Rotavirus', 'Hib', 'RSV', 'Shingles (Zoster)', 'Other',
];

export type DueStatus = 'overdue' | 'due_soon' | 'upcoming' | 'none';

export type ImmunizationLike = { next_due_date: string | null };

/** Days until the next dose is due (negative = overdue); null when unset. */
export function daysUntilDue(im: ImmunizationLike, today: Date = new Date()): number | null {
  if (!im.next_due_date) return null;
  const d = new Date(im.next_due_date + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t0.getTime()) / 86_400_000);
}

export function dueStatus(im: ImmunizationLike, today: Date = new Date()): DueStatus {
  const d = daysUntilDue(im, today);
  if (d === null) return 'none';
  if (d < 0) return 'overdue';
  if (d <= 30) return 'due_soon';
  return 'upcoming';
}

/** Records with a next dose due within `withinDays` (incl. overdue), soonest first. */
export function dueImmunizations<T extends ImmunizationLike>(items: T[], withinDays = 60, today: Date = new Date()): T[] {
  return items
    .map((i) => ({ i, d: daysUntilDue(i, today) }))
    .filter((x): x is { i: T; d: number } => x.d !== null && x.d <= withinDays)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.i);
}

/** Newest-dose-first sort (records without a date sink to the bottom). */
export function sortByDateGiven<T extends { date_given: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const av = a.date_given ?? '', bv = b.date_given ?? '';
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
}
