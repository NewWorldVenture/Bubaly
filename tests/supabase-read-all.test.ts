import { describe, expect, it, vi } from 'vitest';
import { readAll, readAllAsQuery } from '@/lib/supabase/read-all';

// PostgREST answers an unbounded select with at most db-max-rows — 1,000 on a
// default Supabase project — and reports nothing. Measured against a local
// project: a table holding 2,011 rows returns exactly 1,000 rows, no error.
// For a nightly job that iterates every household that is silent data loss, so
// `readAll` pages until an empty page proves the end.
const PAGE = 1000;

/**
 * A fake table of `total` rows.
 *
 * `cap` is the server's own ceiling on a single response — PostgREST's
 * `db-max-rows`, which a project may set BELOW the range we ask for. Default it
 * to our page size, i.e. a server that never caps below what was requested.
 */
function table(total: number, cap = PAGE) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: index }));
  return vi.fn(async (from: number, to: number) => ({
    data: rows.slice(from, Math.min(to + 1, from + cap)),
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
    // Three pages of rows, then one empty page to prove the table ended.
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2011, 3010]]);
  });

  it('keeps reading when the server caps a page below the requested range', async () => {
    // The defect this helper exists to prevent, in the helper itself: a project
    // whose db-max-rows is 500 answers our 1,000-row range with 500 rows. Read
    // that as "the table ended" and 1,511 of these 2,011 rows vanish silently —
    // and resuming at row 1,000 instead of row 500 would skip rows outright.
    const page = table(2011, 500);
    const { rows, error } = await readAll<{ id: number }>(page);

    expect(error).toBeNull();
    expect(rows).toHaveLength(2011);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2011 }, (_, i) => i));
    // Resumed from the rows RECEIVED (500, 1000, …), not the range requested.
    expect(page.mock.calls.map(([from]) => from)).toEqual([0, 500, 1000, 1500, 2000, 2011]);
  });

  it('reads a table that fits well inside a page', async () => {
    const page = table(12);
    const { rows } = await readAll<{ id: number }>(page);
    expect(rows).toHaveLength(12);
    // A short page is not proof of the end, so it still confirms with one more.
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('asks a second time when the first page is exactly full', async () => {
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

  it('treats a page with neither rows nor a reason as a failure', async () => {
    // "No data, no error" is the shape of a silent truncation, not an ending.
    const { error } = await readAll<{ id: number }>(async () => ({ data: null, error: null }));
    expect(error).toBeInstanceOf(Error);
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

describe('readAll with a ceiling the caller chose', () => {
  // `.limit(n)` is not a bound: PostgREST caps a response at db-max-rows no
  // matter what was asked for, so `.limit(5000)` against a default project
  // yields 1,000 and reads like a considered choice. Measured on a live
  // project: a 6,500-row table answered `.limit(5000)` with exactly 1,000.
  // `max` is the same number, honoured.
  it('reads up to the ceiling and no further', async () => {
    const page = table(6500);
    const { rows, error } = await readAll<{ id: number }>(page, { max: 5000 });
    expect(error).toBeNull();
    expect(rows).toHaveLength(5000);
    // Not the 1,000 the server would have handed a `.limit(5000)`.
    expect(rows).not.toHaveLength(PAGE);
    expect(rows.at(-1)).toEqual({ id: 4999 });
  });

  it('asks for only the remainder on the last page', async () => {
    const page = table(6500);
    await readAll<{ id: number }>(page, { max: 2500 });
    // 1000 + 1000 + 500 — never more rows than the ceiling allows.
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2499]]);
  });

  it('stops early when the table ends before the ceiling', async () => {
    const page = table(12);
    const { rows, error } = await readAll<{ id: number }>(page, { max: 5000 });
    expect(error).toBeNull();
    expect(rows).toHaveLength(12);
  });

  it('reports reaching the ceiling as success, not as a runaway query', async () => {
    // The default ceiling is a tripwire and must still report one.
    const page = table(6500);
    const { error } = await readAll<{ id: number }>(page, { max: 1000 });
    expect(error).toBeNull();
  });
});

describe('readAll never rejects', () => {
  // A query builder rejects only when the request never completed — DNS, TCP,
  // TLS, an aborted fetch. Passing that on would put callers back where
  // lib/supabase/settle.ts was written to rescue them: an unhandled rejection
  // inside a page's read batch, rendering "This page hit a snag" instead of the
  // degraded view the page was built to show.
  it('turns a transport rejection into the error shape callers handle', async () => {
    const page = vi.fn(async () => { throw new Error('fetch failed'); });
    const result = await readAll<{ id: number }>(page);
    expect(result.error).toEqual({ message: 'fetch failed' });
    expect(result.rows).toEqual([]);
  });

  it('keeps the rows already read when a later page rejects', async () => {
    const page = vi.fn(async (from: number) => {
      if (from > 0) throw new Error('connection reset');
      return { data: Array.from({ length: PAGE }, (_, i) => ({ id: i })), error: null };
    });
    const { rows, error } = await readAll<{ id: number }>(page);
    expect(rows).toHaveLength(PAGE);
    expect(error).toEqual({ message: 'connection reset' });
  });

  it('survives a rejection that is not an Error', async () => {
    const { error } = await readAll<{ id: number }>(async () => { throw 'gone'; });
    expect(error).toEqual({ message: 'gone' });
  });
});

describe('readAllAsQuery', () => {
  // Exists so an over-capped read inside a settleAll batch can be swapped in
  // place, without taking the batch apart and re-numbering its tuple.
  it('answers in the shape a query answers', async () => {
    const result = await readAllAsQuery<{ id: number }>(table(2011));
    expect(result).toEqual({ data: expect.any(Array), count: null, error: null });
    expect(result.data).toHaveLength(2011);
  });

  it('honours a ceiling', async () => {
    const { data } = await readAllAsQuery<{ id: number }>(table(6500), { max: 5000 });
    expect(data).toHaveLength(5000);
  });

  it('reports a failure as null data, never as an empty table', async () => {
    const { data, error } = await readAllAsQuery<{ id: number }>(
      async () => ({ data: null, error: { message: 'connection reset' } }),
    );
    expect(data).toBeNull();
    expect(error).toEqual({ message: 'connection reset' });
  });
});
