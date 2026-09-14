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
 *
 * REACHING that ceiling is reported. It used to be the one silent exit left in
 * this file: a caller asking for `{ max: 20000 }` got `error: null` whether the
 * table held 14,000 rows or 400,000, which is the same "you received rows and
 * believe that is the table" this helper was written against — only now with the
 * caller's own number on it. `truncated` says which happened, and
 * `failOnMax: true` turns it into the error shape the caller already handles.
 *
 * Telling the two apart costs ONE extra round trip, and only when the ceiling is
 * actually reached: a request for a single row past it. A table of exactly `max`
 * rows answers it empty and is reported complete. This is the same trade the
 * short-page rule above makes, for the same reason — a count that might be the
 * end and might be a cap is not an answer.
 *
 * Use `failOnMax` wherever the rows are SUMMED rather than listed. A truncated
 * list is a display bug; a truncated sum is a wrong number presented as a right
 * one, and the reconciler's correct behaviour at the cap is the error state it
 * already renders, not a green "everything reconciles".
 */
export async function readAll<T, E = { message: string }>(
  page: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  options: { max?: number; failOnMax?: boolean } = {},
): Promise<{ rows: T[]; error: E | { message: string } | null; truncated: boolean }> {
  // A ceiling the CALLER chose is a destination; the default one is a tripwire.
  // Reaching the first is success, reaching the second means the query is not
  // terminating — so the two must not share an exit.
  const ceiling = options.max ?? DEFAULT_MAX_ROWS;
  const rows: T[] = [];

  for (let from = 0; rows.length < ceiling; ) {
    const want = Math.min(PAGE_SIZE, ceiling - rows.length);
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
      return { rows, error: { message: cause instanceof Error ? cause.message : String(cause) }, truncated: false };
    }
    if (error) return { rows, error, truncated: false };
    if (!data) return { rows, error: new Error('The data page was unavailable'), truncated: false };
    if (data.length === 0) return { rows, error: null, truncated: false };

    rows.push(...data);
    from += data.length;
  }

  if (options.max === undefined) {
    return {
      rows,
      error: { message: `readAll stopped at ${ceiling} rows; the query is probably not terminating.` },
      truncated: true,
    };
  }

  // The caller's ceiling was reached. Whether that is "the table ends here" or
  // "there is more and you cannot see it" takes one more request to know, and
  // guessing is what made this exit silent. Ask for the row after the last.
  const capped = rows.slice(0, options.max);
  let truncated = false;
  try {
    const { data: beyond, error: beyondError } = await page(options.max, options.max);
    // A failed probe is not proof of a complete read, so say truncated rather
    // than report success we did not establish.
    truncated = !!beyondError || (beyond?.length ?? 0) > 0;
  } catch {
    truncated = true;
  }

  if (truncated && options.failOnMax) {
    return {
      rows: capped,
      error: { message: `readAll reached its ${options.max}-row ceiling and the table holds more; this read is a prefix, not the table.` },
      truncated: true,
    };
  }
  return { rows: capped, error: null, truncated };
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
  options: { max?: number; failOnMax?: boolean } = {},
): Promise<{ data: T[] | null; count: null; error: E | { message: string } | null; truncated: boolean }> {
  const { rows, error, truncated } = await readAll<T, E>(page, options);
  // A failed read is not an empty table, and inside a batch that difference is
  // the whole point: `data: null` is what the caller's own error branch keys on.
  if (error) return { data: null, count: null, error, truncated };
  return { data: rows, count: null, error: null, truncated };
}
