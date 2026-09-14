import 'server-only';
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
 *
 * That promise is why the batch is settled rather than `Promise.all`-ed. A query
 * builder REJECTS on a transport failure — DNS, TCP, TLS, an aborted fetch — and
 * inside `Promise.all` one rejected chunk rejects the whole read, so the caller
 * receives nothing and its `if (error)` branch never runs. The sentence above
 * would then be false in exactly the outage it matters in. See
 * lib/supabase/settle.ts.
 */
export async function readInChunks<Row, Err>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: Err | null }>,
  chunkSize = 100,
  // A settled transport rejection arrives as { message }, which is not the
  // caller's `Err`. Widening the return says so rather than casting it away:
  // every caller that reads a PostgrestError-only field is then a compile error
  // instead of a runtime `undefined`.
): Promise<{ data: Row[]; error: Err | { message: string } | null }> {
  if (ids.length === 0) return { data: [], error: null };

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  const settled = await settleAll(chunks.map((chunk) => read(chunk)));
  const data: Row[] = [];
  let error: Err | { message: string } | null = null;
  for (const result of settled) {
    if (result.error && !error) error = result.error;
    if (result.data) data.push(...result.data);
  }
  return { data, error };
}
