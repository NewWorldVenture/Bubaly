import type { ReadinessCoverage } from './assess';

export type CalendarReadinessEvent = {
  id: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean | null;
  assignee_id: string | null;
};

type SourceResult<T> = { data: readonly T[] | null; count: number | null; error: unknown };

function coverageOf<T>(source: SourceResult<T>): ReadinessCoverage {
  if (source.error || !Array.isArray(source.data)) return 'unknown';
  return typeof source.count === 'number' && Number.isSafeInteger(source.count) && source.count === source.data.length
    ? 'complete' : 'partial';
}

/** Counts describe only the caller's accessible rows, never private household data. */
export function calendarReadiness(
  source: SourceResult<CalendarReadinessEvent>,
  roster?: SourceResult<{ id: string }>,
) {
  let calendarCoverage = coverageOf(source);
  const rows = calendarCoverage === 'unknown' ? [] : source.data ?? [];
  const timed = rows.filter((event) => !event.all_day);
  const validTimed = timed.filter((event) => {
    const start = Date.parse(event.starts_at);
    const end = event.ends_at ? Date.parse(event.ends_at) : start + 3_600_000;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start;
  });
  if (validTimed.length !== timed.length) calendarCoverage = 'partial';

  let rosterCoverage: ReadinessCoverage = roster ? coverageOf(roster) : 'unknown';
  const members = rosterCoverage === 'unknown' ? [] : roster?.data ?? [];
  const loads = new Map<string, number>();
  for (const member of members) {
    if (typeof member.id !== 'string' || !member.id || loads.has(member.id)) {
      rosterCoverage = 'partial';
      continue;
    }
    loads.set(member.id, 0);
  }

  let workloadCoverage: ReadinessCoverage = calendarCoverage === 'unknown' || rosterCoverage === 'unknown' || !loads.size
    ? 'unknown'
    : calendarCoverage === 'complete' && rosterCoverage === 'complete' ? 'complete' : 'partial';
  for (const event of validTimed) {
    if (!event.assignee_id) continue;
    const load = loads.get(event.assignee_id);
    if (load === undefined) {
      // An inaccessible/unknown assignee is not another zero-load member.
      if (workloadCoverage === 'complete') workloadCoverage = 'partial';
      continue;
    }
    loads.set(event.assignee_id, load + 1);
  }

  let overloadedMembers: number | null = null;
  if (workloadCoverage === 'complete') {
    const values = [...loads.values()];
    const average = values.reduce((sum, load) => sum + load, 0) / values.length;
    overloadedMembers = values.filter((load) => load >= 4 && load > average * 1.5).length;
  }
  return {
    calendarCoverage,
    workloadCoverage,
    conflicts: calendarCoverage === 'unknown' ? null : countOverlaps(validTimed),
    unassigned: calendarCoverage === 'unknown' ? null : rows.filter((event) => !event.assignee_id).length,
    overloadedMembers,
  };
}

/** One overlap rule for both windows; a missing end means one hour. */
function countOverlaps(events: readonly CalendarReadinessEvent[]): number {
  const timed = [...events].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  let count = 0;
  for (let i = 0; i < timed.length; i += 1) {
    const start = Date.parse(timed[i].starts_at);
    const end = timed[i].ends_at ? Date.parse(timed[i].ends_at!) : start + 3_600_000;
    for (let j = i + 1; j < timed.length; j += 1) {
      const otherStart = Date.parse(timed[j].starts_at);
      if (otherStart >= end) break;
      const otherEnd = timed[j].ends_at ? Date.parse(timed[j].ends_at!) : otherStart + 3_600_000;
      if (otherStart < end && start < otherEnd) count += 1;
    }
  }
  return count;
}
