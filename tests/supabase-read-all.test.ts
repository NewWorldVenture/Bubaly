import { describe, expect, it, vi } from 'vitest';
import { readAll } from '@/lib/supabase/read-all';

// PostgREST answers an unbounded select with at most db-max-rows — 1,000 on a
// default Supabase project — and reports nothing. Measured against a local
// project: a table holding 2,011 rows returns exactly 1,000 rows, no error.
// For a nightly job that iterates every household that is silent data loss, so
// `readAll` pages until a short page proves the end.
const PAGE = 1000;

/** A fake table of `total` rows that honours the requested range, as PostgREST does. */
function table(total: number) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: index }));
  return vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to + 1, from + PAGE)),
    error: null,
  }));
}

describe('readAll', () => {
  it('returns every row when the table is larger than one page', async () => {
    const page = table(2011);
    const { rows, error } = await readAll<{ id: number }>(page);

    expect(error).toBeNull();
    expect(rows).toHaveLength(2011);
    // The exact count an unbounded select would have stopped at.
    expect(rows).not.toHaveLength(PAGE);
    expect(rows.at(-1)).toEqual({ id: 2010 });
    expect(page).toHaveBeenCalledTimes(3);
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops after one request when the table fits in a page', async () => {
    const page = table(12);
    const { rows } = await readAll<{ id: number }>(page);
    expect(rows).toHaveLength(12);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('asks a second time when the first page is exactly full', async () => {
    // A full page is not proof of the end — only a short one is.
    const page = table(PAGE);
    const { rows } = await readAll<{ id: number }>(page);
    expect(rows).toHaveLength(PAGE);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('handles an empty table', async () => {
    const page = table(0);
    const { rows, error } = await readAll<{ id: number }>(page);
    expect(rows).toEqual([]);
    expect(error).toBeNull();
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error and keeps the rows already read', async () => {
    // A failure half way through must not read as "the table ended here" —
    // that is the silent truncation this helper exists to prevent.
    const page = vi.fn(async (from: number) => (from === 0
      ? { data: Array.from({ length: PAGE }, (_, i) => ({ id: i })), error: null }
      : { data: null, error: { message: 'connection reset' } }));

    const { rows, error } = await readAll<{ id: number }>(page);
    expect(error).toEqual({ message: 'connection reset' });
    expect(rows).toHaveLength(PAGE);
  });

  it('refuses to page forever', async () => {
    // A query that always returns a full page would otherwise loop until the
    // process died.
    const page = vi.fn(async () => ({
      data: Array.from({ length: PAGE }, (_, i) => ({ id: i })),
      error: null,
    }));
    const { error } = await readAll<{ id: number }>(page);
    expect(error?.message).toMatch(/not terminating/);
  });
});
