// lib/moments/summary.ts — a one-glance tally of the upcoming moments, so the
// Moments page answers "how much still needs me?" before the family reads a
// single card. Pure + tested; the view passes its already-built moment list plus
// the done-map and the conflict map.

export type MomentSummaryInput = {
  event: { id: string };
  prep: { items: { id: string }[] };
};

export type MomentSummary = {
  total: number;
  ready: number;      // every prep step checked
  needPrep: number;   // total − ready
  conflicts: number;  // moments that double-book another event
};

/**
 * Tally the moments. A moment is "ready" when all its prep steps are in the
 * done-map for that event (an empty-prep moment counts as ready). A moment is a
 * conflict when its event id appears in the overlaps map with ≥1 clasher.
 */
export function summarizeMoments(
  moments: MomentSummaryInput[],
  done: Record<string, string[]>,
  clashes: Record<string, string[]>,
): MomentSummary {
  let ready = 0;
  let conflicts = 0;
  for (const m of moments ?? []) {
    const doneIds = new Set(done[m.event.id] ?? []);
    const items = m.prep.items ?? [];
    if (items.length > 0 && items.every((i) => doneIds.has(i.id))) ready += 1;
    else if (items.length === 0) ready += 1;
    if ((clashes[m.event.id]?.length ?? 0) > 0) conflicts += 1;
  }
  const total = (moments ?? []).length;
  return { total, ready, needPrep: total - ready, conflicts };
}
