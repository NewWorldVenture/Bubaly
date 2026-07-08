// lib/home/front-door.ts — R5: the proactive front door (pure, unit-tested).
//
// The category-defining Home moment: instead of a wall of widgets, lead with what
// the assistant has ALREADY done for the family and the few things that still need
// a human — "I already handled 3 things; 2 need your OK." Transparent (every item
// is named + linkable) and reversible (done items link to Autopilot where they can
// be undone). This module turns the raw rows into that summary; the page renders it.

export type FrontDoorDone = { id: string; title: string; kind?: string | null };
export type FrontDoorPending = { id: string; title: string; agent?: string | null; priority?: string | null };

export interface FrontDoor {
  /** False when there's nothing to say — the hero hides entirely. */
  show: boolean;
  /** One proactive sentence. */
  headline: string;
  /** A short sample of what was auto-handled (reversible). */
  done: FrontDoorDone[];
  /** A short sample of what's waiting on a human, most urgent first. */
  pending: FrontDoorPending[];
  /** True totals (may exceed the listed samples). */
  doneCount: number;
  pendingCount: number;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** The proactive one-liner for the given counts. */
export function frontDoorHeadline(doneCount: number, pendingCount: number): string {
  const did = doneCount === 1 ? 'handled 1 thing' : `handled ${doneCount} things`;
  const wait = pendingCount === 1 ? '1 needs your OK' : `${pendingCount} need your OK`;
  if (doneCount > 0 && pendingCount > 0) return `I already ${did} — ${wait}.`;
  if (doneCount > 0) return `I already ${did} for you — nothing needs you right now.`;
  if (pendingCount > 0) return pendingCount === 1 ? 'One thing is waiting on your OK.' : `${pendingCount} things are waiting on your OK.`;
  return "You're all caught up — nothing needs you right now.";
}

/**
 * Assemble the front door. `doneCount`/`pendingCount` may be passed when the true
 * totals exceed the listed samples (the page fetches counts separately); otherwise
 * they default to the sample sizes. Pending is sorted most-urgent first.
 */
export function buildFrontDoor(input: {
  done?: FrontDoorDone[];
  pending?: FrontDoorPending[];
  doneCount?: number;
  pendingCount?: number;
}): FrontDoor {
  const done = input.done ?? [];
  const pending = [...(input.pending ?? [])].sort(
    (a, b) => (PRIORITY_RANK[a.priority ?? 'normal'] ?? 2) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 2),
  );
  const doneCount = input.doneCount ?? done.length;
  const pendingCount = input.pendingCount ?? pending.length;
  return {
    show: doneCount > 0 || pendingCount > 0,
    headline: frontDoorHeadline(doneCount, pendingCount),
    done,
    pending,
    doneCount,
    pendingCount,
  };
}
