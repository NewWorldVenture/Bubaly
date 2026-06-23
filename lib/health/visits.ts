// Pure health-visit helpers — unit tested, no deps.

export type VisitKind =
  | 'medical' | 'dental' | 'vision' | 'mental_health' | 'specialist'
  | 'vaccination' | 'therapy' | 'urgent_care' | 'other';

export const VISIT_KINDS: { id: VisitKind; label: string; icon: string }[] = [
  { id: 'medical', label: 'Medical', icon: '🩺' },
  { id: 'dental', label: 'Dental', icon: '🦷' },
  { id: 'vision', label: 'Vision', icon: '👓' },
  { id: 'vaccination', label: 'Vaccination', icon: '💉' },
  { id: 'specialist', label: 'Specialist', icon: '🏥' },
  { id: 'mental_health', label: 'Mental health', icon: '🧠' },
  { id: 'therapy', label: 'Therapy', icon: '🧑‍⚕️' },
  { id: 'urgent_care', label: 'Urgent care', icon: '🚑' },
  { id: 'other', label: 'Other', icon: '📋' },
];

export function visitKindMeta(kind: string): { label: string; icon: string } {
  return VISIT_KINDS.find((k) => k.id === kind) ?? { label: kind, icon: '📋' };
}

export type VisitLike = { follow_up_date: string | null; visit_date: string };

/** Days until a follow-up (negative = overdue); null when no follow-up set. */
export function daysUntilFollowUp(visit: VisitLike, today: Date = new Date()): number | null {
  if (!visit.follow_up_date) return null;
  const d = new Date(visit.follow_up_date + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t0.getTime()) / 86_400_000);
}

/** Upcoming/overdue follow-ups within `withinDays`, soonest (most overdue) first. */
export function upcomingFollowUps<T extends VisitLike>(visits: T[], withinDays = 60, today: Date = new Date()): T[] {
  return visits
    .map((v) => ({ v, d: daysUntilFollowUp(v, today) }))
    .filter((x): x is { v: T; d: number } => x.d !== null && x.d <= withinDays)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.v);
}

/** Newest-visit-first sort. */
export function sortByVisitDate<T extends { visit_date: string }>(visits: T[]): T[] {
  return [...visits].sort((a, b) => (a.visit_date < b.visit_date ? 1 : a.visit_date > b.visit_date ? -1 : 0));
}
