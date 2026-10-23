// lib/notifications/fair-batch.ts — how push and email dispatch share a batch.
// Pure: no Supabase or provider calls of its own, so it stays unit testable.
//
// WHY. Push (lib/server/push.ts) and the email digest
// (lib/server/notification-emails.ts) each take a bounded batch of pending
// notifications in created_at order: 200 rows a tick for push, 500 a day for
// email. A member's session may still INSERT a notification addressed to
// themselves (0388's notif_insert: is_family_member(family_id) and
// user_id = auth.uid()), with any number of rows and any created_at, send_at,
// pushed_at or sent_at, because no column grant or trigger pins them. No
// writer in the application needs that insert: notify() writes with the
// service role, and so do the guardian, escalation, contact-centre and
// generator writers. Until the policy is dropped (an owner action), a child
// could fill every batch with rows of their own, dated 1970 so they sort first,
// and hold back every family's pushes and every digest until the flood drained,
// and plant more the next day.
//
// WHAT THIS BOUNDS. Such a row can only ever be addressed to the member who
// planted it, never to anyone else and never to the whole family (user_id
// null). So a batch is filled fairly by RECIPIENT: no one recipient takes more
// than `perRecipient` rows while anyone else's rows are waiting in the same
// range, and only when the range holds nobody else's do that recipient's
// further rows fill the room left. A recipient with a large backlog of their
// own still gets it in one batch when nobody else is waiting; a flood takes no
// more than its share of a batch while anyone else is waiting. Several members
// flooding at once each take only their share, but together they still take
// that many shares of each batch: this bounds the damage, and dropping the
// policy is what ends it.
//
// Rows dated after now (beyond a clock-skew allowance) are not read at all, by
// either dispatcher: no writer sets created_at, which defaults to now(), so
// such a row can only be planted, and one dated in the future sat outside the
// push retry window for ever.

/** The allowance for the app host's clock against the database's when windowing on created_at. */
export const NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The latest created_at a pending notification may carry and still be read, as an ISO instant. */
export function latestCreatedAt(now: Date): string {
  return new Date(now.getTime() + NOTIFICATION_CLOCK_SKEW_MS).toISOString();
}

/**
 * The value list of a PostgREST `in` filter over recipient ids. The ids come
 * from a uuid column, so anything outside letters, digits, `_` and `-` is not
 * one and would be filter syntax: refused rather than interpolated.
 */
export function recipientList(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Notification recipient id is not a key.');
  }
  return `(${ids.join(',')})`;
}

type Pending = { id: string; user_id: string | null };

/**
 * Read one batch of up to `size` rows, fairly by recipient.
 *
 * `read(size, excluded)` must return the next `size` pending rows of ONE range
 * in the dispatcher's order, leaving out every row addressed to a recipient in
 * `excluded` (and never a whole-family row). Rows come back grouped as the
 * reads found them, not re-sorted: a caller that needs its order sorts them.
 *
 * Each round, a recipient holding more than `perRecipient` rows of the page
 * keeps their first `perRecipient` and is left out of the next read, which
 * reads the rest of the room from the same start. Every such recipient had at
 * least one row more in the page than they keep, so each read reaches at least
 * as far as the one before; the room never falls to zero, and once it is no
 * larger than `perRecipient` nobody can exceed it, so the rounds end. Fewer
 * than `size / perRecipient` recipients are ever left out (nine for push and
 * for email), which keeps the excluded list short enough for the request line
 * and the reads to one per recipient left out, one more, and the fill. When the
 * last read comes back short, nobody else's row is waiting in the range, and
 * one read without exclusions fills the room left with the held recipients'
 * further rows. Every read happens before anything is sent.
 */
export async function readFairBatch<T extends Pending>(
  read: (size: number, excluded: readonly string[]) => Promise<T[]>,
  size: number,
  perRecipient: number,
): Promise<T[]> {
  if (!Number.isInteger(size) || size < 1) return [];
  if (!Number.isInteger(perRecipient) || perRecipient < 1) throw new Error('A recipient share must be a positive integer.');
  const held = new Map<string, T[]>();
  let room = size;
  let page: T[] = [];
  let short = false;
  for (;;) {
    const raw = await read(room, [...held.keys()]);
    short = raw.length < room;
    // A read that ignored the exclusion must not count a held recipient twice.
    page = raw.filter((row) => !row.user_id || !held.has(row.user_id));
    const byRecipient = new Map<string, T[]>();
    for (const row of page) {
      if (!row.user_id) continue;
      const rows = byRecipient.get(row.user_id) ?? [];
      rows.push(row);
      byRecipient.set(row.user_id, rows);
    }
    const over = [...byRecipient].filter(([, rows]) => rows.length > perRecipient);
    if (over.length === 0) break;
    for (const [recipient, rows] of over) held.set(recipient, rows.slice(0, perRecipient));
    room = size - perRecipient * held.size;
  }
  const batch = [...[...held.values()].flat(), ...page];
  if (held.size === 0 || !short || batch.length >= size) return batch;
  const seen = new Set(batch.map((row) => row.id));
  for (const row of await read(size, [])) {
    if (batch.length >= size) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    batch.push(row);
  }
  return batch;
}
