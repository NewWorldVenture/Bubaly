// lib/moments/conflicts.ts — "detect scheduling conflicts before they exist".
//
// Given the family's timed events, find genuine double-bookings (overlapping time
// windows) so a moment can quietly warn "Overlaps Sam's recital" before the day
// arrives. Uses real end times to stay precise, NOT noisy: all-day items and
// merely-adjacent events don't count. Pure + tested.

export type TimedEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
};

/** Default assumed duration (minutes) when an event has no end time. */
const DEFAULT_DURATION_MIN = 60;

function windowOf(e: TimedEvent): { start: number; end: number } | null {
  const start = Date.parse(e.starts_at);
  if (!Number.isFinite(start)) return null;
  let end = e.ends_at ? Date.parse(e.ends_at) : NaN;
  if (!Number.isFinite(end) || end <= start) end = start + DEFAULT_DURATION_MIN * 60000;
  return { start, end };
}

/**
 * Map of eventId → titles of the other events whose time window truly overlaps it
 * (a.start < b.end && b.start < a.end). All-day / undated events are ignored, so
 * this only ever surfaces real clashes. Titles are de-duplicated and sorted for a
 * stable, testable order.
 */
export function findOverlaps(events: TimedEvent[]): Record<string, string[]> {
  const timed = (events ?? [])
    .filter((e) => !e.all_day)
    .map((e) => ({ e, w: windowOf(e) }))
    .filter((x): x is { e: TimedEvent; w: { start: number; end: number } } => x.w !== null);

  const out: Record<string, Set<string>> = {};
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (a.w.start < b.w.end && b.w.start < a.w.end) {
        (out[a.e.id] ??= new Set()).add(b.e.title);
        (out[b.e.id] ??= new Set()).add(a.e.title);
      }
    }
  }
  const result: Record<string, string[]> = {};
  for (const [id, titles] of Object.entries(out)) result[id] = [...titles].sort();
  return result;
}
