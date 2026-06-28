// lib/home/conflicts.ts — pure calendar double-booking detection for the Home
// "Needs you" surface. The family shouldn't have to scan the calendar to notice
// they've double-booked — Bubaly notices. DOM-free + unit-testable.

export type ConflictEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  assignee_id: string | null;
};

export type EventConflict = {
  assigneeId: string;
  eventIds: string[];
  startsAt: string; // earliest start in the overlapping cluster (ISO)
};

/**
 * Find clusters of overlapping TIMED events that share the same (non-null)
 * assignee — i.e. one person double-booked. All-day and unassigned events are
 * ignored (too noisy / not a personal conflict). Events with no `ends_at` are
 * given a default duration. Intervals are half-open, so back-to-back events
 * (one ends exactly as the next starts) are NOT a conflict.
 */
export function detectConflicts(events: ConflictEvent[], defaultDurationMin = 60): EventConflict[] {
  const byAssignee = new Map<string, { id: string; start: number; end: number; startIso: string }[]>();

  for (const e of events ?? []) {
    if (!e.assignee_id || e.all_day) continue;
    const start = Date.parse(e.starts_at);
    if (!Number.isFinite(start)) continue;
    let end = e.ends_at ? Date.parse(e.ends_at) : NaN;
    if (!Number.isFinite(end) || end <= start) end = start + defaultDurationMin * 60_000;
    const arr = byAssignee.get(e.assignee_id) ?? [];
    arr.push({ id: e.id, start, end, startIso: e.starts_at });
    byAssignee.set(e.assignee_id, arr);
  }

  const conflicts: EventConflict[] = [];
  for (const [assigneeId, list] of byAssignee) {
    list.sort((a, b) => a.start - b.start);
    let cluster: typeof list = [];
    let clusterEnd = -Infinity;
    const flush = () => {
      if (cluster.length >= 2) {
        conflicts.push({ assigneeId, eventIds: cluster.map((x) => x.id), startsAt: cluster[0].startIso });
      }
      cluster = [];
      clusterEnd = -Infinity;
    };
    for (const ev of list) {
      if (cluster.length > 0 && ev.start < clusterEnd) {
        cluster.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.end);
      } else {
        flush();
        cluster = [ev];
        clusterEnd = ev.end;
      }
    }
    flush();
  }

  // Stable order: earliest conflict first.
  return conflicts.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
