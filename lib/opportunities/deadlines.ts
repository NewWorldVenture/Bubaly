// lib/opportunities/deadlines.ts — pure helpers for the Signups tracker.
//
// No Supabase / React imports so deadline math and bucketing stay
// deterministically unit-testable. Deadlines are date-only (YYYY-MM-DD) and
// reasoned about in whole local days.

export type OpportunityStatus = 'interested' | 'registered' | 'waitlisted' | 'passed' | 'missed';

export interface OpportunityLike {
  id: string;
  deadline: string | null; // YYYY-MM-DD
  status: OpportunityStatus;
}

const MS_DAY = 24 * 60 * 60 * 1000;

function dayDiff(aKey: string, bKey: string): number {
  const a = Date.UTC(+aKey.slice(0, 4), +aKey.slice(5, 7) - 1, +aKey.slice(8, 10));
  const b = Date.UTC(+bKey.slice(0, 4), +bKey.slice(5, 7) - 1, +bKey.slice(8, 10));
  return Math.round((b - a) / MS_DAY);
}

/** An opportunity is "open" while the family hasn't acted/closed it out. */
export function isOpen(o: OpportunityLike): boolean {
  return o.status === 'interested' || o.status === 'waitlisted';
}

/**
 * Whole days from `todayKey` until the deadline.
 *  > 0 upcoming, 0 due today, < 0 past. null when no deadline.
 */
export function daysToDeadline(o: OpportunityLike, todayKey: string): number | null {
  if (!o.deadline) return null;
  return dayDiff(todayKey, o.deadline);
}

/** Open opportunity whose deadline has passed — the alert we never want to miss. */
export function isMissed(o: OpportunityLike, todayKey: string): boolean {
  if (!isOpen(o) || !o.deadline) return false;
  return dayDiff(todayKey, o.deadline) < 0;
}

/** Open opportunity whose deadline is within `days` (inclusive) and not past. */
export function isClosingSoon(o: OpportunityLike, todayKey: string, days = 7): boolean {
  if (!isOpen(o) || !o.deadline) return false;
  const d = dayDiff(todayKey, o.deadline);
  return d >= 0 && d <= days;
}

export type UrgencyBucket = 'missed' | 'closing_soon' | 'upcoming' | 'no_deadline' | 'done';

/** Classifies an opportunity into an urgency bucket for grouping. */
export function urgencyBucket(o: OpportunityLike, todayKey: string, soonDays = 7): UrgencyBucket {
  if (!isOpen(o)) return 'done';
  if (!o.deadline) return 'no_deadline';
  const d = dayDiff(todayKey, o.deadline);
  if (d < 0) return 'missed';
  if (d <= soonDays) return 'closing_soon';
  return 'upcoming';
}

/** Groups opportunities into ordered buckets; dated buckets sorted by deadline. */
export function groupByUrgency<T extends OpportunityLike>(items: T[], todayKey: string, soonDays = 7): Record<UrgencyBucket, T[]> {
  const out: Record<UrgencyBucket, T[]> = { missed: [], closing_soon: [], upcoming: [], no_deadline: [], done: [] };
  for (const o of items) out[urgencyBucket(o, todayKey, soonDays)].push(o);
  const byDeadline = (a: T, b: T) => (a.deadline ?? '').localeCompare(b.deadline ?? '');
  out.missed.sort(byDeadline); out.closing_soon.sort(byDeadline); out.upcoming.sort(byDeadline);
  return out;
}

export interface OpportunityStats {
  open: number;
  closingSoon: number;
  missed: number;
  registered: number;
}

export function opportunityStats(items: OpportunityLike[], todayKey: string, soonDays = 7): OpportunityStats {
  return {
    open: items.filter(isOpen).length,
    closingSoon: items.filter((o) => isClosingSoon(o, todayKey, soonDays)).length,
    missed: items.filter((o) => isMissed(o, todayKey)).length,
    registered: items.filter((o) => o.status === 'registered').length,
  };
}

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  interested: 'Interested', registered: 'Registered', waitlisted: 'Waitlisted', passed: 'Passed', missed: 'Missed',
};
export const URGENCY_BUCKET_LABELS: Record<UrgencyBucket, string> = {
  missed: 'Deadline passed', closing_soon: 'Closing soon', upcoming: 'Upcoming', no_deadline: 'No deadline', done: 'Decided',
};
