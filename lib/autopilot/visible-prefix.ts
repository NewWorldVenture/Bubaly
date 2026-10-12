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
// Client-safe and pure apart from the read it is handed.

/** One page of the caller's query: rows `from`..`to`, inclusive, in a total order. */
export type PrefixPage<T, E> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>;

/**
 * Up to `limit` rows of `page`'s order that `visible` keeps.
 *
 * The first page asks for `limit` rows — the read the caller always made — and
 * a reader who keeps every one is answered in one round trip. Each further
 * page asks for twice as many as the last, from where the last ended, while
 * hidden rows leave this reader short and the last page came back full. A
 * short page ends it: the rows ran out, or the server capped the read. A
 * failed page fails the whole read, as the one query would.
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
  const kept: T[] = [];
  if (opts.limit <= 0) return { data: kept, error: null };
  for (let from = 0, size = opts.limit; ; from += size, size *= 2) {
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    for (const row of rows) {
      if (!opts.visible(row)) continue;
      kept.push(row);
      if (kept.length >= opts.limit) return { data: kept, error: null };
    }
    if (rows.length < size) return { data: kept, error: null };
  }
}
