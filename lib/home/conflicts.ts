// lib/home/conflicts.ts — pure calendar double-booking detection for the Home
// "Needs you" surface. The family shouldn't have to scan the calendar to notice
// they've double-booked — Bubaly notices. DOM-free + unit-testable.

import { calendarConsumerNativeId, type CalendarConsumerEvent } from '@/lib/calendar/consumer-spans';
import type { CalendarSnapshotReference } from '@/lib/calendar/source-snapshot';
import { compareExactInstants, parseExactInstant } from '@/lib/calendar/exact-instant';
export type ConflictEvent = CalendarConsumerEvent & { conflictStartsAt?: string; conflictEndsAt?: string };

export type EventConflict = {
  assigneeId: string;
  eventIds: string[];
  occurrenceKeys?: string[];
  references?: CalendarSnapshotReference[];
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
  const byAssignee = new Map<string, { id: string; start: bigint; end: bigint; startIso: string; key?: string; reference?: CalendarSnapshotReference }[]>();

  for (const e of events ?? []) {
    if (!e.assignee_id || e.all_day) continue;
    const id = calendarConsumerNativeId(e);
    if (!id) continue; // A source attendee is not a native family assignment.
    const startIso = e.conflictStartsAt ?? ('actualStartsAt' in e ? e.actualStartsAt : e.starts_at);
    let start: bigint;
    try { start = parseExactInstant(startIso); } catch { continue; }
    const rawEnd = e.conflictEndsAt ?? ('actualEndsAt' in e ? e.actualEndsAt : e.ends_at);
    let end = start + BigInt(defaultDurationMin * 60_000) * 1_000_000n;
    if (rawEnd) { try { const parsed = parseExactInstant(rawEnd); if (parsed >= start) end = parsed; } catch { /* Retain the established missing/invalid-end estimate. */ } }
    // A point event stays on the schedule but occupies no interval to clash.
    if (end <= start) continue;
    const arr = byAssignee.get(e.assignee_id) ?? [];
    arr.push({ id, start, end, startIso, ...('occurrenceKey' in e ? { key: e.occurrenceKey, reference: e.reference } : {}) });
    byAssignee.set(e.assignee_id, arr);
  }

  const conflicts: EventConflict[] = [];
  for (const [assigneeId, list] of byAssignee) {
    list.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    let cluster: typeof list = [];
    let clusterEnd: bigint | null = null;
    const flush = () => {
      if (cluster.length >= 2) {
        conflicts.push({ assigneeId, eventIds: cluster.map((x) => x.id), startsAt: cluster[0].startIso,
          ...(cluster.some(x => x.key) ? { occurrenceKeys: cluster.flatMap(x => x.key ? [x.key] : []), references: cluster.flatMap(x => x.reference ? [x.reference] : []) } : {}),
        });
      }
      cluster = [];
      clusterEnd = null;
    };
    for (const ev of list) {
      if (cluster.length > 0 && clusterEnd !== null && ev.start < clusterEnd) {
        cluster.push(ev);
        if (ev.end > clusterEnd) clusterEnd = ev.end;
      } else {
        flush();
        cluster = [ev];
        clusterEnd = ev.end;
      }
    }
    flush();
  }

  // Stable order: earliest conflict first.
  return conflicts.sort((a, b) => compareExactInstants(a.startsAt, b.startsAt));
}
