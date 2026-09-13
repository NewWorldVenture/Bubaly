// Reading a WHOLE table, when "whole" actually matters.
//
// PostgREST answers an unbounded `select()` with at most `db-max-rows` — 1,000
// on a default Supabase project — and says nothing about it. No error, no
// header the client surfaces, no short-read signal: the caller simply receives
// 1,000 rows and believes that is the table.
//
// For a page that renders a list, that is a display bug. For a nightly job that
// iterates every household, it is silent data loss: family 1,001 onwards never
// gets its digest, its reminders, or its push scan, and nothing anywhere
// reports a failure. Measured directly against a local project — a table
// holding 2,011 rows returns exactly 1,000 to an unbounded select.
//
// `readAll` pages with `.range()` until a short page proves the end. Use it
// wherever completeness is part of the job's contract; use an explicit
// `.limit()` wherever it is not.

const PAGE_SIZE = 1000;
/** A stop so a paging bug cannot become an infinite loop: 1,000,000 rows. */
const MAX_PAGES = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Read every row a query matches, a page at a time.
 *
 * `page` is called with the row range to fetch and must apply it to the query
 * it builds — the query cannot be reused across pages because a PostgREST
 * builder is single-use:
 *
 *   const families = await readAll<{ id: string }>((from, to) =>
 *     supabase.from('families').select('id').range(from, to));
 *
 * Ordering is the caller's business, but an unordered paged read can repeat or
 * skip rows between pages; pass a stable `.order()` when the rows matter
 * individually.
 */
export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const rows: T[] = [];

  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };

    const batch = data ?? [];
    rows.push(...batch);
    // A short page is the end of the table. A full one might not be, so ask again.
    if (batch.length < PAGE_SIZE) return { rows, error: null };
  }

  return {
    rows,
    error: { message: `readAll stopped at ${MAX_PAGES * PAGE_SIZE} rows; the query is probably not terminating.` },
  };
}
