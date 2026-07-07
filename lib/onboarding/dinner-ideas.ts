// lib/onboarding/dinner-ideas.ts — pure dinner-idea selection for the first-run
// briefing (T2). A brand-new family has no recipes of its own, so the briefing's
// "3 dinner ideas" come from the curated meal_ideas catalog. This picks 3 that fit
// the day: quick meals when today is busy, more involved ones on the weekend.
// Deterministic (seeded by the calendar date) so the same day always suggests the
// same three — stable to look at, fresh day to day. DOM-free + fully unit-tested.

export type DinnerEffort = 'quick' | 'standard' | 'involved';

export interface DinnerIdea {
  title: string;
  cuisine: string;
  effort: DinnerEffort;
  prepMinutes: number;
  description: string | null;
}

export interface PickDinnerOptions {
  now: Date;
  /** Today's event count — a busy day biases toward quick meals. */
  busyCount?: number;
}

/** Day-of-year (UTC) — the deterministic seed so a given day is stable. */
function dayOfYear(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start;
  return Math.floor(diff / 86_400_000);
}

function isWeekend(now: Date): boolean {
  const d = now.getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Pick 3 dinner ideas for the day. Preference order for the effort that fits the
 * day is tried first (quick on a busy weekday, involved on the weekend, standard
 * otherwise), then we fill from everything else so we always return up to 3 even
 * if the catalog is thin. Selection is rotated by day-of-year so it's stable
 * within a day and varies across days — never random, so tests are deterministic.
 */
export function pickDinnerIdeas(candidates: DinnerIdea[], opts: PickDinnerOptions): DinnerIdea[] {
  const pool = (candidates ?? []).filter((c) => c && typeof c.title === 'string' && c.title.trim().length > 0);
  if (pool.length === 0) return [];

  const busy = (opts.busyCount ?? 0) >= 3;
  const preferred: DinnerEffort = busy ? 'quick' : isWeekend(opts.now) ? 'involved' : 'standard';

  // Stable ordering, then rotate by the day so the trio changes daily.
  const byTitle = [...pool].sort((a, b) => a.title.localeCompare(b.title));
  const rot = dayOfYear(opts.now) % byTitle.length;
  const rotated = [...byTitle.slice(rot), ...byTitle.slice(0, rot)];

  const preferredFirst = [
    ...rotated.filter((c) => c.effort === preferred),
    ...rotated.filter((c) => c.effort !== preferred),
  ];

  // De-dup by title while taking the first 3.
  const seen = new Set<string>();
  const out: DinnerIdea[] = [];
  for (const c of preferredFirst) {
    if (seen.has(c.title)) continue;
    seen.add(c.title);
    out.push(c);
    if (out.length === 3) break;
  }
  return out;
}
