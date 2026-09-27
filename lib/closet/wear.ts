// lib/closet/wear.ts — one worn outfit adds exactly one wear to each item.
//
// The closet module used to write `wear_count: cached + 1`, where `cached` was
// the count this browser loaded. Two members logging an outfit that shares an
// item (siblings in a shared hoodie, two phones on one child) both wrote
// `cached + 1`, and one wear vanished — which then understates cost-per-wear and
// promotes the item into "neglected". The table has no increment RPC, and adding
// one is a migration production cannot take yet, so the bump is a
// compare-and-swap: read the live count, write +1 only while it is still that
// count, and re-read when another writer got there first. Audit C1-S9-90.

import { wroteNoRows } from '@/lib/supabase/errors';

type ReadResult = { data: { wear_count: number | null } | null; error: unknown };
type WriteResult = { data: unknown[] | null; error: unknown };

/** The two calls this needs, so a test can drive the race without a database. */
export type WearStore = {
  readWearCount(id: string): PromiseLike<ReadResult>;
  /** UPDATE … SET wear_count = next WHERE id = id AND wear_count = expected, returning the row. */
  writeWearCount(id: string, expected: number, next: number, wornOn: string): PromiseLike<WriteResult>;
};

export type WearBump =
  | { ok: true }
  | { ok: false; reason: 'error'; error: unknown }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'contended' };

/** How many times another writer may move the count under us before we say so. */
export const WEAR_BUMP_ATTEMPTS = 4;

export async function bumpWearCount(store: WearStore, id: string, wornOn: string): Promise<WearBump> {
  for (let attempt = 0; attempt < WEAR_BUMP_ATTEMPTS; attempt++) {
    const read = await store.readWearCount(id);
    if (read.error) return { ok: false, reason: 'error', error: read.error };
    // No row: deleted, or not one this member may see. Either way nothing moved.
    if (!read.data) return { ok: false, reason: 'missing' };
    const current = read.data.wear_count ?? 0;
    const write = await store.writeWearCount(id, current, current + 1, wornOn);
    if (write.error) return { ok: false, reason: 'error', error: write.error };
    if (!wroteNoRows(write.data)) return { ok: true };
    // Zero rows with the row still readable: the count moved since the read.
    // Read again rather than overwrite the other writer's wear.
  }
  return { ok: false, reason: 'contended' };
}
