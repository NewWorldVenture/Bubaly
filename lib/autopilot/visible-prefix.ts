// lib/autopilot/visible-prefix.ts — the first N cards of a list that THIS
// reader may see.
//
// `autopilot_suggestions` is read under 0085's family-wide policy, and who a
// card is for is decided after the read (lib/autopilot/audience.ts). A list
// that takes its first N rows and THEN drops the ones a reader may not see is
// a list of what survived N: twenty insurance cards a child is not shown left
// Home's Autopilot panel empty for that child, with an otherwise visible
// twenty-first card behind them, and eight did the same to the assistant's
// proactive context. So the reader's rule is applied before the prefix is
// taken: the read is paged, in the caller's order, until N kept rows are in
// hand or the rows run out.
//
// The rows run out only when a page comes back EMPTY. PostgREST caps every
// response at `db-max-rows` and says nothing (lib/supabase/read-all.ts), so a
// page shorter than asked is as likely the server's cap as the end: read as
// the end, a proactive read of eight past sixteen hidden cards, from a server
// capping at eight, asked for rows 8–23, was handed 8–15, and never read the
// reader's own card at 16. Each page starts where the rows actually returned
// end, and one more round trip tells the end from the cap.
//
// Client-safe and pure apart from the read it is handed. The reminder lists
// page the same way (lib/autopilot/reminder-cards.ts readVisibleReminders).

/** One page of the caller's query: rows `from`..`to`, inclusive, in a total order. */
export type PrefixPage<T, E> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>;

/**
 * How many rows of a read the paging looks through for a reader's prefix
 * before it answers with what it has. A stop for a runaway read — a reader
 * with ten thousand rows hidden ahead of their own, or a page that ignores
 * its range and never comes back empty — never a bound on a healthy one: the
 * longest prefix any caller asks for is a few hundred rows.
 */
export const VISIBLE_PREFIX_SCAN_LIMIT = 10_000;

/**
 * Up to `limit` rows of `page`'s order, kept page by page by `keep`.
 *
 * The first page asks for `limit` rows — the read the caller always made — and
 * a reader who keeps every one is answered in one round trip. Each further
 * page asks for twice as many as the last (never more than
 * VISIBLE_PREFIX_SCAN_LIMIT, so a long run of capped pages never asks for an
 * absurd range), from where the rows the last one RETURNED end (a page the
 * server capped is followed, not skipped past). It
 * ends when `limit` rows are kept, when a page comes back empty (the rows ran
 * out; a short page is not that), or past VISIBLE_PREFIX_SCAN_LIMIT rows read.
 * A failed page fails the whole read, as the one query would.
 *
 * `keep(rows, wanted)` answers the page's rows this reader keeps, in order;
 * it need not answer more than `wanted`, and what it answers past that is not
 * used.
 */
export async function readKeptPrefix<T, E = unknown>(
  page: PrefixPage<T, E>,
  limit: number,
  keep: (rows: T[], wanted: number) => T[] | PromiseLike<T[]>,
): Promise<{ data: T[] | null; error: E | null }> {
  const kept: T[] = [];
  if (limit <= 0) return { data: kept, error: null };
  for (let from = 0, size = limit; from < VISIBLE_PREFIX_SCAN_LIMIT; size = Math.min(size * 2, VISIBLE_PREFIX_SCAN_LIMIT)) {
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    if (rows.length === 0) break;
    const wanted = limit - kept.length;
    kept.push(...(await keep(rows, wanted)).slice(0, wanted));
    if (kept.length >= limit) break;
    from += rows.length;
  }
  return { data: kept, error: null };
}

/**
 * Up to `limit` rows of `page`'s order that `visible` keeps (readKeptPrefix).
 *
 * `visible` is called for each row in order and not after the prefix is full,
 * so a caller that counts what it withholds counts only rows ahead of the last
 * one it lists. `page` must order by a unique key last (`id`), or pages can
 * repeat and skip rows at their boundaries.
 */
export async function readVisiblePrefix<T, E = unknown>(
  page: PrefixPage<T, E>,
  opts: { limit: number; visible: (row: T) => boolean },
): Promise<{ data: T[] | null; error: E | null }> {
  return readKeptPrefix(page, opts.limit, (rows, wanted) => {
    const kept: T[] = [];
    for (const row of rows) {
      if (kept.length >= wanted) break;
      if (opts.visible(row)) kept.push(row);
    }
    return kept;
  });
}
