// lib/family/conflicts.ts
// Pure scheduling-conflict detection + deterministic "quick fix" math, shared by
// the AI Conflict Resolution page and the Command Center. Kept pure (no DB) so the
// overlap logic is unit-tested in isolation. The AI layer adds human-friendly
// resolution ideas on top of these facts; the quick fixes below are exact and
// safe to apply with one tap.

export type TimedEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  location?: string | null;
  assignee_id?: string | null;
};

export type Conflict = {
  a: TimedEvent; // the earlier-starting event
  b: TimedEvent; // the later-starting event that overlaps it
  overlapStartIso: string;
  overlapEndIso: string;
  overlapMinutes: number;
};

const HOUR_MS = 3_600_000;

/** End time of an event, defaulting to start + 1h when ends_at is missing. */
export function eventEnd(e: TimedEvent): number {
  const start = new Date(e.starts_at).getTime();
  return e.ends_at ? new Date(e.ends_at).getTime() : start + HOUR_MS;
}

/**
 * Find every pair of overlapping timed events. All-day events and events with
 * invalid dates are ignored. O(n log n + k): sort by start, then sweep forward
 * only while starts overlap. Returns conflicts ordered by the earlier start.
 *
 * `maxConflicts` bounds `k`. The sweep is linear in the OUTPUT, and the output
 * is quadratic when a calendar is dense: 723 events inside one fortnight — an
 * ordinary shared family calendar with a few subscribed feeds — produced enough
 * overlapping pairs to render hundreds of megabytes of HTML and hang the page.
 * Callers that render or count a bounded number should say so; the default is
 * unbounded, so existing callers keep their exact behaviour.
 */
export function detectConflicts(
  events: TimedEvent[],
  { maxConflicts = Number.POSITIVE_INFINITY }: { maxConflicts?: number } = {},
): Conflict[] {
  const timed = events
    .filter((e) => !e.all_day && !Number.isNaN(new Date(e.starts_at).getTime()))
    .sort((x, y) => new Date(x.starts_at).getTime() - new Date(y.starts_at).getTime());

  const conflicts: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    const aStart = new Date(timed[i].starts_at).getTime();
    const aEnd = eventEnd(timed[i]);
    for (let j = i + 1; j < timed.length; j++) {
      const bStart = new Date(timed[j].starts_at).getTime();
      if (bStart >= aEnd) break; // sorted — nothing later can overlap i
      const bEnd = eventEnd(timed[j]);
      if (bStart < aEnd && aStart < bEnd) {
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        conflicts.push({
          a: timed[i],
          b: timed[j],
          overlapStartIso: new Date(overlapStart).toISOString(),
          overlapEndIso: new Date(overlapEnd).toISOString(),
          overlapMinutes: Math.max(1, Math.round((overlapEnd - overlapStart) / 60000)),
        });
        if (conflicts.length >= maxConflicts) return conflicts;
      }
    }
  }
  return conflicts;
}

export type QuickFix = {
  /** The event this fix moves. */
  eventId: string;
  label: string;
  startsAtIso: string;
  endsAtIso: string;
};

/**
 * Deterministic, exact one-tap fix: move the later event to begin the moment the
 * earlier one ends, preserving the later event's duration. Always valid, so the
 * UI can apply it without the AI. Returns null only if dates are unusable.
 */
export function quickFixMoveAfter(conflict: Conflict): QuickFix | null {
  const { a, b } = conflict;
  const aEnd = eventEnd(a);
  const bStart = new Date(b.starts_at).getTime();
  const bEnd = eventEnd(b);
  if (Number.isNaN(aEnd) || Number.isNaN(bStart)) return null;
  const duration = Math.max(bEnd - bStart, HOUR_MS / 2);
  const newStart = aEnd;
  const newEnd = aEnd + duration;
  return {
    eventId: b.id,
    label: `Move “${b.title}” to start right after “${a.title}” ends`,
    startsAtIso: new Date(newStart).toISOString(),
    endsAtIso: new Date(newEnd).toISOString(),
  };
}
