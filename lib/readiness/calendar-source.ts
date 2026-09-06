import { detectConflicts, type TimedEvent } from '@/lib/family/conflicts';
import { mostLoaded } from '@/lib/operating-index/score';
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

  // THE RULE THE PAGE IT LINKS TO RUNS. The month gap sends a person to the
  // Family Operating Index, so it answers with that page's own `mostLoaded`
  // rather than a second threshold written here — otherwise a family can be
  // told "1 person carrying a heavy load" and land somewhere naming nobody.
  //
  // Same rule, narrower input: the index feeds it events AND open tasks, this
  // feeds it events alone. It can therefore name nobody where that page would,
  // never the reverse, which is the safe direction for a gap whose whole job is
  // to send someone there. It identifies at most one member, so this is 0 or 1.
  let overloadedMembers: number | null = null;
  if (workloadCoverage === 'complete') {
    overloadedMembers = mostLoaded(
      [...loads.entries()].map(([memberId, upcoming]) => ({ memberId, name: memberId, upcoming, openTasks: 0 })),
    ) ? 1 : 0;
  }
  return {
    calendarCoverage,
    workloadCoverage,
    conflicts: calendarCoverage === 'unknown' ? null : countOverlaps(validTimed),
    unassigned: calendarCoverage === 'unknown' ? null : rows.filter((event) => !event.assignee_id).length,
    overloadedMembers,
  };
}

/**
 * THE COUNT MUST MATCH THE PAGE IT SENDS YOU TO. The gap reads "2 clashes this
 * week" and links to /dashboard/conflicts, which runs
 * `lib/family/conflicts.ts detectConflicts`. A private copy of that sweep here
 * could — and did — disagree with the page it points at about the same week.
 *
 * (The Family Operating Index deliberately uses the OTHER rule,
 * `lib/home/conflicts.ts`: one PERSON double-booked. Two named rules, each used
 * consistently, rather than a third written inline.)
 */
function countOverlaps(events: readonly CalendarReadinessEvent[]): number {
  return detectConflicts(events.map((e): TimedEvent => ({
    id: e.id, title: '', starts_at: e.starts_at, ends_at: e.ends_at,
    all_day: Boolean(e.all_day), assignee_id: e.assignee_id,
  }))).length;
}
