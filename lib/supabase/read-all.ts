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
// `readAll` pages with `.range()` until an EMPTY page proves the end. Use it
// wherever completeness is part of the job's contract; use an explicit
// `.limit()` wherever it is not.

/** Rows requested per round trip. The server may answer with fewer. */
const PAGE_SIZE = 1000;
/** A stop so a paging bug cannot become an infinite loop. */
const DEFAULT_MAX_ROWS = 1_000_000;

type PageResult<T, E> = { data: T[] | null; error: E | null };

/**
 * Read every row a query matches, a page at a time.
 *
 * `page` is called with the row range to fetch and must apply it to the query
 * it builds — the query cannot be reused across pages because a PostgREST
 * builder is single-use:
 *
 *   const families = await readAll<{ id: string }>((from, to) =>
 *     supabase.from('families').select('id').order('id').range(from, to));
 *
 * Ordering is the caller's business, but an unordered paged read can repeat or
 * skip rows between pages; pass a stable `.order()` when the rows matter
 * individually.
 *
 * Two rules keep this honest against a server that silently caps a response:
 *
 *  - Advance by the rows actually RECEIVED, never by the range requested. Ask
 *    for 1,000 from a project whose `db-max-rows` is 500 and you are handed
 *    500; resuming at 1,000 would skip the 500 rows in between.
 *  - Stop only on an EMPTY page. A short page is not proof of the end — it is
 *    equally the signature of that cap — so it costs one extra round trip to
 *    tell the two apart, and that is the whole point of this helper.
 *
 * A page that reports neither rows nor an error is treated as a failure rather
 * than as the end of the table: "no data, no reason" is precisely the shape of
 * the silent truncation this exists to prevent.
 *
 * `options.max` is a REAL ceiling, which `.limit(n)` above is not: PostgREST
 * caps a response at `db-max-rows` no matter what the client asked for, so
 * `.limit(5000)` against a default project quietly yields 1,000 and reads like a
 * considered bound. Measured: a table of 6,500 rows answered `.limit(5000)`
 * with exactly 1,000. Pass the number you actually mean here and it is honoured
 * by paging to it.
 */
export async function readAll<T, E = { message: string }>(
  page: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  options: { max?: number } = {},
): Promise<{ rows: T[]; error: E | { message: string } | null }> {
  // A ceiling the CALLER chose is a destination; the default one is a tripwire.
  // Reaching the second means the query is not terminating. Reaching the first
  // used to be treated as success — and that was wrong, which is the whole point
  // of the `probe` below.
  //
  // A caller's `max` is a bound they expect the data to FIT UNDER. Stopping
  // exactly on it and returning `error: null` makes a truncated read
  // indistinguishable from a complete one, which is the same silent-partial-read
  // defect this module was written to end (F-008, F-011, F-013) reappearing one
  // level up. The admin wallet reconciliation page reads 20,000 rows this way
  // and its own header says reading part of the ledger is worse than not reading
  // it at all — it would have reported "everything reconciles" over a prefix.
  //
  // So read ONE row past the ceiling. That single extra row is what separates
  // "there were exactly `max` rows" (complete, no error) from "there were more
  // than `max`" (truncated, an error the caller already knows how to render).
  const ceiling = options.max ?? DEFAULT_MAX_ROWS;
  const probe = ceiling + 1;
  const rows: T[] = [];

  for (let from = 0; rows.length < probe; ) {
    const want = Math.min(PAGE_SIZE, probe - rows.length);
    // A query builder RESOLVES with `{ data, error }` for anything the database
    // answers, and REJECTS only when the request never completed — DNS, TCP,
    // TLS, an aborted fetch. A reader that passed that rejection on would put
    // every caller back where `lib/supabase/settle.ts` was written to rescue
    // them: an unhandled rejection inside a page's read batch, rendering the
    // error boundary instead of the degraded view. So it never rejects; a
    // transport failure arrives as the error shape callers already handle.
    let data: T[] | null;
    let error: E | { message: string } | null;
    try {
      ({ data, error } = await page(from, from + want - 1));
    } catch (cause) {
      return { rows, error: { message: cause instanceof Error ? cause.message : String(cause) } };
    }
    if (error) return { rows, error };
    if (!data) return { rows, error: new Error('The data page was unavailable') };
    if (data.length === 0) return { rows, error: null };

    rows.push(...data);
    from += data.length;
  }

  if (options.max !== undefined) {
    return {
      rows: rows.slice(0, ceiling),
      error: {
        message: `readAll reached the caller's max of ${ceiling} rows and more remain. `
          + 'These rows are a PREFIX, not the whole set — treat this as a failed read, '
          + 'or raise the max.',
      },
    };
  }
  return {
    rows: rows.slice(0, ceiling),
    error: { message: `readAll stopped at ${ceiling} rows; the query is probably not terminating.` },
  };
}

/**
 * `readAll` in the shape a Supabase query answers.
 *
 * Most over-capped reads live inside a `settleAll([...])` batch, destructured
 * positionally as `{ data: events }`. Returning `{ rows }` there would force
 * every such batch to be taken apart, which is a lot of churn and a lot of
 * chances to get a tuple position wrong. This answers `{ data, count, error }`
 * instead, so the call site swaps one expression and nothing else moves.
 *
 * `count` is always null: paging reads rows, it does not ask for a count.
 */
export async function readAllAsQuery<T, E = { message: string }>(
  page: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  options: { max?: number } = {},
): Promise<{ data: T[] | null; count: null; error: E | { message: string } | null }> {
  const { rows, error } = await readAll<T, E>(page, options);
  // A failed read is not an empty table, and inside a batch that difference is
  // the whole point: `data: null` is what the caller's own error branch keys on.
  if (error) return { data: null, count: null, error };
  return { data: rows, count: null, error: null };
}
