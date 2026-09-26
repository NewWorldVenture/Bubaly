import 'server-only';
import { readAll } from './read-all';
import { settleAll } from '@/lib/supabase/settle';

/**
 * Run an `.in(column, ids)` read in batches.
 *
 * PostgREST filters travel in the query string, so one `.in()` carrying a few
 * hundred UUIDs builds a URL of roughly 40 bytes per id. Past the gateway's
 * request-line limit the whole read comes back `URI too long` — and because the
 * calling page usually treats that as "no rows", the failure shows up as
 * silently missing data rather than as an error. It only appears once a table
 * has enough rows, so it survives every test against a small dataset.
 *
 * 100 ids per request keeps the longest URL near 4 KB, well inside the common
 * 8 KB limit, and the batches run in parallel.
 *
 * The first error wins and the rows gathered so far are still returned, which
 * matches how the single-request version behaves for callers that log the error
 * and render what they have.
 */
export async function readInChunks<Row, Err>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: Err | null }>,
  chunkSize = 100,
  // A settled transport rejection arrives as { message }, which is not the
  // caller's `Err`. Widening the return says so rather than casting it away.
): Promise<{ data: Row[]; error: Err | { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  // settleAll, not Promise.all: a TRANSPORT rejection (DNS, TCP, TLS, an
  // aborted fetch) rejects the whole batch, and the caller's error branch never
  // runs — the page renders its error boundary instead of its degraded view.
  // Settling turns that into the { error } shape every caller already handles.
  const settled = await settleAll(chunks.map((chunk) => read(chunk)));
  const data: Row[] = [];
  let error: Err | { message: string } | null = null;
  for (const result of settled) {
    if (result.error && !error) error = result.error;
    if (result.data) data.push(...result.data);
  }
  return { data, error };
}

/**
 * `.in(column, ids)` where BOTH limits bite: the URL and the row count.
 *
 * `readInChunks` above solves the first — a hundred ids per request keeps the
 * query string inside the gateway's limit. It does not solve the second. A
 * chunk of a hundred families matches a hundred families' worth of rows, and
 * chores, transactions or members run to dozens each, so one chunk's response
 * reaches PostgREST's `db-max-rows` long before the id list does. The answer
 * comes back short, with no error, exactly as `read-all.ts` describes.
 *
 * So chunk the ids AND page each chunk. Pass the range through to `.range()`
 * and give the query a `.order()` that is unique — a primary key, not the
 * `family_id` being filtered on — or pages can repeat and skip rows.
 *
 * A failed read returns `data: null`, not the rows gathered so far: for a
 * caller that aggregates per owner, a partial answer is not a smaller answer,
 * it is a WRONG one, and `null` is what its error branch already keys on.
 */
export async function readAllInChunks<Row, Err = { message: string }>(
  ids: readonly string[],
  page: (chunk: string[], from: number, to: number) => PromiseLike<{ data: Row[] | null; error: Err | null }>,
  options: { chunkSize?: number } = {},
): Promise<{ data: Row[] | null; error: Err | { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };
  const chunkSize = options.chunkSize ?? 100;

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  const settled = await settleAll(
    chunks.map((chunk) => readAll<Row, Err>((from, to) => page(chunk, from, to))),
  );

  const data: Row[] = [];
  for (const result of settled) {
    if (result.error) return { data: null, error: result.error };
    // `settleAll`'s transport fallback is shaped for a Supabase QUERY result —
    // { data, count, error } — and carries no `rows`, so the union needs an
    // explicit narrowing rather than truthiness on `error`. A fallback always
    // has an error and is returned above; this guard is for the type system and
    // for the impossible case, which is reported rather than silently treated
    // as an empty chunk.
    if (!('rows' in result)) {
      return { data: null, error: { message: 'chunked read settled without rows' } };
    }
    data.push(...result.rows);
  }
  return { data, error: null };
}
