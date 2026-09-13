import { readAll } from '@/lib/supabase/read-all';

/** Read every page before a caller makes a claim about absent household data.
 * The factory must apply family scope and a stable order on each page.
 *
 * The paging itself lives in `readAll` — there is one loop, not two. This wrapper
 * keeps the stricter contract its callers rely on: a failure anywhere yields no
 * rows at all, so a partial read can never be mistaken for the household's
 * complete history. */
export async function readAllPages<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ data: T[] | null; error: unknown }> {
  const { rows, error } = await readAll<T, unknown>(read);
  if (error) return { data: null, error };
  return { data: rows, error: null };
}
