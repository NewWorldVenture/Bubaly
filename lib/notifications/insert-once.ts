// lib/notifications/insert-once.ts — the one way a batch of notification rows
// is written once 0489's index stands behind the dedupe reads.
//
// Both writers of `notifications` — the engine (lib/server/notifications.ts)
// and `notify()` (lib/services/notifications) — decide what to write with a
// read, then insert. Nothing in the database stood behind that read, and two of
// the engine's callers run for one family at the same minute (the daily cron
// and the two-hourly push scan are each mirrored by Vercel and the GitHub
// dispatcher), so two runs could both read "not yet announced" and both write:
// one duplicate per occurrence per concurrent pair. 0489 adds a partial unique
// index over (family_id, type, related_id, user_id) for UNREAD rows with a key,
// so the second writer is refused with 23505 instead.
//
// Postgres refuses the WHOLE statement for one offending row, and a batch of a
// hundred candidates is not a hundred duplicates: it is one occurrence another
// run wrote a moment ago. So a refused batch is written again one row at a
// time, and only the rows the index refuses are left out. The caller learns how
// many were refused, and nothing else about the batch changes.

/** Postgres: duplicate key value violates a unique constraint. */
export const UNIQUE_VIOLATION = '23505';

export type InsertedIds = { data: { id: string }[] | null; error: { code?: string; message: string } | null };

export type InsertOnceResult = {
  /** Rows that landed: every row of a statement the database accepted. */
  written: number;
  /** Their ids as the database returned them (`select('id')`), in the order written. */
  ids: string[];
  /** Rows the unique index refused: another run had already written that occurrence. */
  refused: number;
  /** A failure other than a refusal. Rows written before it stand (`ids`). */
  error: { code?: string; message: string } | null;
};

/**
 * Inserts `rows` through `write` (an `insert(rows).select('id')` on the
 * notifications table), one statement when every row is new, one row at a
 * time when the batch is refused for a duplicate.
 */
export async function insertNotificationRows<R>(
  rows: R[],
  write: (rows: R[]) => PromiseLike<InsertedIds>,
): Promise<InsertOnceResult> {
  if (rows.length === 0) return { written: 0, ids: [], refused: 0, error: null };
  const batch = await write(rows);
  if (!batch.error) return { written: rows.length, ids: idsOf(batch.data), refused: 0, error: null };
  if (batch.error.code !== UNIQUE_VIOLATION) return { written: 0, ids: [], refused: 0, error: batch.error };

  // One row of the batch is already there — written by a concurrent run between
  // this run's dedupe read and this insert. Write the rest around it.
  const ids: string[] = [];
  let written = 0;
  let refused = 0;
  for (const row of rows) {
    const one = await write([row]);
    if (!one.error) { written += 1; ids.push(...idsOf(one.data)); continue; }
    if (one.error.code === UNIQUE_VIOLATION) { refused += 1; continue; }
    return { written, ids, refused, error: one.error };
  }
  return { written, ids, refused, error: null };
}

const idsOf = (data: InsertedIds['data']): string[] => (data ?? []).map((r) => r.id);
