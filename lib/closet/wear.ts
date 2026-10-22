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
//
// One tap of "Wear" is several writes — a bump per item, then the outfit_logs
// row — and no transaction spans them. A tap that fails part-way therefore
// TAKES BACK the wears that did land (takeBackWear), so the retry its error
// invites counts once instead of twice (HC2). That is as far as a client can
// go: the take-back is itself a write that can fail, and a reply lost in
// transit leaves the client unable to know what committed. Then the closet
// says the counts may already include the wear, rather than "not saved".
// Making the tap all-or-nothing needs a database primitive — one RPC that
// inserts the log and increments the counts in a single transaction — which
// is a migration, not something this file can do. Pinned by
// tests/a-failed-wear-takes-its-counts-back.test.ts.
//
// What a take-back puts back exactly is the COUNT. The last-worn DATE it puts
// back only as far as one column with no history allows (HD2). A take-back
// knows the date its own bump read, and that is the right one only while its
// wear is still the latest on the row — which it can judge only by the count,
// the one thing the row carries. Two failed taps on one item that overlap
// (two phones) show where that stops: A lands (4 → 5, today), B lands (5 → 6,
// and reads A's "today" as the date before it), A is taken back first and has
// to keep today because B's wear might still commit, and then B puts back the
// "today" it read. The count is 4 again, no log exists, and the item says it
// was worn today. Taken back the other way round, or with either tap
// committing, the date comes out right; a take-back that leaves no wear at
// all clears the date, so a never-worn item comes out right in both orders.
// Nor is an equal count proof that the latest wear is ours: if, between our
// bump and our take-back, one wear was taken back and another landed, the
// count reads the same, and across midnight the date goes back to a day
// earlier than the wear that landed. A date that is always right needs a
// database primitive — the same single transaction, or a last_worn_on
// derived from outfit_logs — so the closet does not claim it. Pinned by the
// same test file.

import { wroteNoRows } from '@/lib/supabase/errors';

type ReadResult = { data: { wear_count: number | null; last_worn_on: string | null } | null; error: unknown };
type WriteResult = { data: unknown[] | null; error: unknown };

/** The two calls this needs, so a test can drive the race without a database. */
export type WearStore = {
  readWearCount(id: string): PromiseLike<ReadResult>;
  /** UPDATE … SET wear_count = next, last_worn_on = wornOn WHERE id = id AND wear_count = expected, returning the row. */
  writeWearCount(id: string, expected: number, next: number, wornOn: string | null): PromiseLike<WriteResult>;
};

/** A wear that landed, and what the row said before it: what takeBackWear needs to undo it. */
export type LandedWear = { id: string; count: number; lastWornBefore: string | null };

export type WearBump =
  | { ok: true }
  | { ok: false; reason: 'error'; error: unknown }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'contended' };

/** How many times another writer may move the count under us before we say so. */
export const WEAR_BUMP_ATTEMPTS = 4;

/** Each wear that lands is recorded in `landed`, so a tap that fails elsewhere can take it back. */
export async function bumpWearCount(store: WearStore, id: string, wornOn: string, landed?: LandedWear[]): Promise<WearBump> {
  for (let attempt = 0; attempt < WEAR_BUMP_ATTEMPTS; attempt++) {
    const read = await store.readWearCount(id);
    if (read.error) return { ok: false, reason: 'error', error: read.error };
    // No row: deleted, or not one this member may see. Either way nothing moved.
    if (!read.data) return { ok: false, reason: 'missing' };
    const current = read.data.wear_count ?? 0;
    const write = await store.writeWearCount(id, current, current + 1, wornOn);
    if (write.error) return { ok: false, reason: 'error', error: write.error };
    if (!wroteNoRows(write.data)) {
      landed?.push({ id, count: current + 1, lastWornBefore: read.data.last_worn_on });
      return { ok: true };
    }
    // Zero rows with the row still readable: the count moved since the read.
    // Read again rather than overwrite the other writer's wear.
  }
  return { ok: false, reason: 'contended' };
}

/**
 * Take back one wear that landed, for a tap that failed elsewhere (HC2).
 *
 * The same compare-and-swap as the bump, the other way: -1 on the LIVE count,
 * so a wear another member logged meanwhile stays counted. That count is
 * exact; the date is not always (HD2, see the header). It goes back to what
 * this wear's bump read while the count says this wear is still the latest;
 * it is cleared when no wear is left; otherwise the live date stays, because
 * a later wear set it and may commit — and if that wear fails too, its own
 * take-back puts back the date it read, which was this one's. True once the
 * wear is gone (or the item is), false when it could not be taken back.
 */
export async function takeBackWear(store: WearStore, wear: LandedWear): Promise<boolean> {
  for (let attempt = 0; attempt < WEAR_BUMP_ATTEMPTS; attempt++) {
    const read = await store.readWearCount(wear.id);
    if (read.error) return false;
    // Deleted since: there is no count left for this wear to inflate.
    if (!read.data) return true;
    const current = read.data.wear_count ?? 0;
    if (current < 1) return true;
    // No wear left is an item never worn, whatever date the wears taken back
    // left behind: the one case besides "ours is the latest" with a known date.
    const lastWorn = current === wear.count ? wear.lastWornBefore : current === 1 ? null : read.data.last_worn_on;
    const write = await store.writeWearCount(wear.id, current, current - 1, lastWorn);
    if (write.error) return false;
    if (!wroteNoRows(write.data)) return true;
  }
  return false;
}
