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
// A member can also CAUSE whole-family rows (user_id null) in their own
// family, and in every family watching a listing of theirs: 0191's
// marketplace_log_price_change (SECURITY DEFINER, after update of price_cents)
// writes one to each family that saved the listing on every price drop, with
// no dedupe or throttle, and the listing's owner may PATCH its price up and
// down at will. So "who planted it" is not always the row's recipient. It is
// always the row's FAMILY: every such row lands in a family the member
// belongs to or one that chose to watch them.
//
// WHAT THIS BOUNDS. A batch is shared by FAMILY first: no family takes more
// than `perFamily` rows while another family's rows are waiting in the range,
// whether those rows are addressed to members or to the whole family. Inside
// a family it is shared by recipient, the family's whole-family rows counting
// as one more recipient: no one of them takes more than `perRecipient` rows
// while anyone else's are waiting, so a child's flood (of their own rows, or
// of price-drop notices) does not hold back a parent's row either. Only when
// nobody else is waiting does a family's surplus, and then a recipient's,
// fill the room left: a lone family's backlog still goes out a full batch at
// a time. An attacker holding several families still takes that many family
// shares; this bounds the damage, and dropping the policy (and throttling the
// trigger, both owner actions) is what ends it.
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
 * The value list of a PostgREST `in` filter over recipient or family ids. The
 * ids come from uuid columns, so anything outside letters, digits, `_` and `-`
 * is not one and would be filter syntax: refused rather than interpolated.
 */
export function recipientList(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Notification recipient id is not a key.');
  }
  return `(${ids.join(',')})`;
}

/** A pending notification as the batch shares it out. */
export type FairRow = { id: string; family_id: string; user_id: string | null };

/** What one read of a range leaves out. */
export type FairExclusion = {
  /** Every row of these families. */
  readonly families: readonly string[];
  /** Rows addressed to these users. */
  readonly recipients: readonly string[];
  /** The whole-family rows (user_id null) of these families. */
  readonly familyWide: readonly string[];
};

/** How much of a batch one family, and one recipient inside it, takes while anyone else's rows are waiting. */
export type FairShares = { readonly perFamily: number; readonly perRecipient: number };

/**
 * `read(size, excluded)` returns the next `size` pending rows of ONE range in
 * the dispatcher's order, leaving out every row `excluded` names.
 */
export type FairRead<T extends FairRow> = (size: number, excluded: FairExclusion) => Promise<T[]>;

const NOTHING: FairExclusion = { families: [], recipients: [], familyWide: [] };

/** Whether `excluded` leaves this row out. */
export function isExcluded(excluded: FairExclusion, row: FairRow): boolean {
  if (excluded.families.includes(row.family_id)) return true;
  return row.user_id ? excluded.recipients.includes(row.user_id) : excluded.familyWide.includes(row.family_id);
}

function isNothing(excluded: FairExclusion): boolean {
  return !excluded.families.length && !excluded.recipients.length && !excluded.familyWide.length;
}

/** Whether every row `narrower` leaves out, `wider` leaves out too. */
function within(narrower: FairExclusion, wider: FairExclusion): boolean {
  return narrower.families.every((id) => wider.families.includes(id))
    && narrower.recipients.every((id) => wider.recipients.includes(id))
    && narrower.familyWide.every((id) => wider.familyWide.includes(id));
}

/**
 * Read one batch of up to `size` rows, fairly by family and, inside a family,
 * by recipient (its whole-family rows counting as one recipient).
 *
 * Rows are taken in the order the reads return them and never given back. In
 * the first pass a row is taken only while its family is under `perFamily`
 * and its recipient under `perRecipient`; a family or recipient that reaches
 * its share is left out of every later read, which starts again from the top
 * of the range and asks for the room left plus the rows already taken that it
 * will return again. When a read comes back short, nobody but those left out
 * has a row waiting, and the next pass lifts one level: the family shares
 * first (so a parent's row in a family a flood filled is reached, still shared
 * by recipient), then everything (the surplus, in order). A pass whose
 * exclusions are the ones the last short read already used is skipped, so a
 * batch nobody floods is one read. Each round leaves out at least one more
 * family or recipient, each holding a full share of the batch, so the rounds
 * are bounded (size / perFamily + size / perRecipient, plus one a pass) and so
 * is the exclusion list. Every read happens before anything is sent. Rows come
 * back in the order they were taken, not re-sorted: a caller that needs its
 * order sorts them.
 */
export async function readFairBatch<T extends FairRow>(read: FairRead<T>, size: number, shares: FairShares): Promise<T[]> {
  if (!Number.isInteger(size) || size < 1) return [];
  const { perFamily, perRecipient } = shares;
  if (!Number.isInteger(perRecipient) || perRecipient < 1 || !Number.isInteger(perFamily) || perFamily < perRecipient) {
    throw new Error('A batch share must be a positive integer, and a family\'s no smaller than a recipient\'s.');
  }
  const taken = new Map<string, T>();
  const byFamily = new Map<string, number>();
  const byRecipient = new Map<string, number>();
  const fullFamilies = new Set<string>();
  const fullRecipients = new Set<string>();
  const fullFamilyWide = new Set<string>();
  const recipientOf = (row: T) => (row.user_id ? `user:${row.user_id}` : `family:${row.family_id}`);
  let lastShort: FairExclusion | null = null;

  /**
   * 'full' when the batch is; 'done' when this pass can take nothing more:
   * the range ran out under its exclusions, or a read that ignored them came
   * back with nothing this pass may take (an honest read that is not short
   * always fills the room), and the next, wider pass is the one to ask.
   */
  const pass = async (level: 'family' | 'recipient' | 'surplus'): Promise<'full' | 'done'> => {
    for (;;) {
      const room = size - taken.size;
      if (room <= 0) return 'full';
      const excluded: FairExclusion = level === 'surplus' ? NOTHING : {
        families: level === 'family' ? [...fullFamilies] : [],
        recipients: [...fullRecipients],
        familyWide: [...fullFamilyWide],
      };
      if (lastShort && within(excluded, lastShort) && within(lastShort, excluded)) return 'done';
      let again = 0;
      for (const row of taken.values()) if (!isExcluded(excluded, row)) again += 1;
      const want = room + again;
      const rows = await read(want, excluded);
      let reached = false;
      let added = 0;
      for (const row of rows) {
        // A read that ignored the exclusion must not count a row twice.
        if (taken.has(row.id) || isExcluded(excluded, row)) continue;
        if (added >= room) break;
        const recipient = recipientOf(row);
        const familyFull = level === 'family' && (byFamily.get(row.family_id) ?? 0) >= perFamily;
        const recipientFull = level !== 'surplus' && (byRecipient.get(recipient) ?? 0) >= perRecipient;
        if (familyFull) fullFamilies.add(row.family_id);
        if (recipientFull) {
          if (row.user_id) fullRecipients.add(row.user_id);
          else fullFamilyWide.add(row.family_id);
        }
        if (familyFull || recipientFull) { reached = true; continue; }
        taken.set(row.id, row);
        added += 1;
        byFamily.set(row.family_id, (byFamily.get(row.family_id) ?? 0) + 1);
        byRecipient.set(recipient, (byRecipient.get(recipient) ?? 0) + 1);
      }
      if (taken.size >= size) return 'full';
      if (reached) continue;
      if (rows.length < want) lastShort = excluded;
      return 'done';
    }
  };

  for (const level of ['family', 'recipient', 'surplus'] as const) {
    if (await pass(level) === 'full') break;
  }
  return [...taken.values()];
}

/**
 * One read over a cursor's two ranges, for readFairBatch: the rows ahead of
 * the cursor and the rows behind it (push's retries: failed deliveries inside
 * the retry window, rows skipped for configuration or cut by the run's time
 * budget, and any surplus a fair batch left behind).
 *
 * Behind the cursor keeps `behindShare` of each read for itself, so retries
 * progress whatever lies ahead: the wrap used to run only when the forward
 * page came back short, and one member's rows kept it full. Ahead takes the
 * rest, and any part of the reserve the retries do not need. Rows behind come
 * first in what the read returns, so the reserve is taken before the rows
 * ahead fill the room. A read that came back short is remembered: a later read
 * leaving out at least as much is answered from it instead of asking again.
 */
export function aheadAndBehind<T extends FairRow>(ahead: FairRead<T>, behind: FairRead<T>, behindShare: number) {
  if (!(behindShare >= 0 && behindShare < 1)) throw new Error('The retries\' share of a read must be a fraction below one.');
  const remembered = (range: FairRead<T>) => {
    const seen = new Set<string>();
    const short: { excluded: FairExclusion; rows: T[] }[] = [];
    const readRange: FairRead<T> = async (size, excluded) => {
      if (size < 1) return [];
      const known = short.find((answer) => within(answer.excluded, excluded));
      if (known) return known.rows.filter((row) => !isExcluded(excluded, row)).slice(0, size);
      const rows = await range(size, excluded);
      for (const row of rows) seen.add(row.id);
      if (rows.length < size) short.push({ excluded, rows });
      return rows;
    };
    return { read: readRange, seen, short };
  };
  const forward = remembered(ahead);
  const wrap = remembered(behind);
  const read: FairRead<T> = async (size, excluded) => {
    const reserve = Math.floor(size * behindShare);
    let first = await forward.read(size - reserve, excluded);
    const second = await wrap.read(size - first.length, excluded);
    // The retries left part of their reserve: give it to the rows ahead.
    if (reserve > 0 && first.length === size - reserve && second.length < size - first.length) {
      first = await forward.read(size - second.length, excluded);
    }
    return [...second, ...first];
  };
  return {
    read,
    /** Whether this row of the batch was read from behind the cursor. */
    isBehind: (row: FairRow) => wrap.seen.has(row.id) && !forward.seen.has(row.id),
    /**
     * Whether the batch holds every row ahead of the cursor: a read of that
     * range leaving nothing out came back short, and the batch took every row
     * it returned. Only then has the traversal reached the end and wraps.
     */
    aheadExhausted: (batch: readonly FairRow[]) => {
      const ids = new Set(batch.map((row) => row.id));
      return forward.short.some((answer) => isNothing(answer.excluded) && answer.rows.every((row) => ids.has(row.id)));
    },
  };
}
