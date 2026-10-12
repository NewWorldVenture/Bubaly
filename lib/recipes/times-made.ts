// lib/recipes/times-made.ts — "Made it today" adds exactly one cook.
//
// The recipes screen wrote `times_made: (r.times_made ?? 0) + 1`, where `r` was
// the snapshot the detail modal opened with. Nothing refreshed that snapshot,
// so a second tap in the same modal wrote the same N+1 again, and two members
// marking the same recipe both wrote N+1 — one cook lost. family_recipes is not
// realtime-published either, so a page loaded before another member's cook kept
// the stale N indefinitely. The table has no increment RPC, and adding one is a
// migration, so the bump is the same compare-and-swap the closet's wear count
// uses (lib/closet/wear.ts, Audit C1-S9-90): read the live count, write +1 only
// while it is still that count, and read again when another writer got there
// first.

import { wroteNoRows } from '@/lib/supabase/errors';

type ReadResult = { data: { times_made: number | null } | null; error: unknown };
type WriteResult = { data: unknown[] | null; error: unknown };

/** The two calls this needs, so a test can drive the race without a database. */
export type TimesMadeStore = {
  readTimesMade(id: string): PromiseLike<ReadResult>;
  /** UPDATE … SET times_made = next, last_made_at = madeAt WHERE id = id AND times_made = expected, returning the row. */
  writeTimesMade(id: string, expected: number, next: number, madeAt: string): PromiseLike<WriteResult>;
};

/**
 * Shaped like a PostgREST reply so the caller reads it the way it reads every
 * other write: `error` set when a read or write failed, `data` null with no
 * error when nothing moved (the recipe is gone, or four writers in a row beat
 * this one to it).
 */
export type MadeBump =
  | { data: { timesMade: number }; error: null }
  | { data: null; error: unknown; reason: 'error' }
  | { data: null; error: null; reason: 'missing' | 'contended' };

/** How many times another writer may move the count under us before we say so. */
export const MADE_BUMP_ATTEMPTS = 4;

export async function markRecipeMade(store: TimesMadeStore, id: string, madeAt: string): Promise<MadeBump> {
  for (let attempt = 0; attempt < MADE_BUMP_ATTEMPTS; attempt++) {
    const read = await store.readTimesMade(id);
    if (read.error) return { data: null, error: read.error, reason: 'error' };
    // No row: deleted, or not one this member may see. Either way nothing moved.
    if (!read.data) return { data: null, error: null, reason: 'missing' };
    const current = read.data.times_made ?? 0;
    const write = await store.writeTimesMade(id, current, current + 1, madeAt);
    if (write.error) return { data: null, error: write.error, reason: 'error' };
    if (!wroteNoRows(write.data)) return { data: { timesMade: current + 1 }, error: null };
    // Zero rows with the row still readable: the count moved since the read.
    // Read again rather than overwrite the other writer's cook.
  }
  return { data: null, error: null, reason: 'contended' };
}
