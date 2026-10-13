import { describe, expect, it } from 'vitest';
import { readAll, readAllById, readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// AUD-1040-LEDGER-PAGING. A ledger is SUMMED, and it is written to while it is
// read: a child asks for a reward, a parent approves a chore. An offset read
// pages on positions, so a row written ahead of the next offset pushes the last
// row of one page onto the next, and the sum counts it twice. readAllById pages
// on `id > last` instead: every row that existed when the read began is read
// exactly once, whatever is written between the pages.

type Row = { id: string; family_id: string; cost_points: number; status: string };
const FAMILY = 'family-1';
const id = (i: number) => `r-${String(i).padStart(4, '0')}`;

function ledger(rows: number) {
  const db = createInMemorySupabase({ maxRows: 1000 });
  db.seed('reward_redemptions', Array.from({ length: rows }, (_, i) => ({
    id: id(i), family_id: FAMILY, cost_points: 1, status: 'approved',
  })));
  return db;
}
const byKey = (db: ReturnType<typeof ledger>, onPage?: (n: number) => void) => {
  let n = 0;
  return (after: string | null, limit: number) => {
    onPage?.(++n);
    let q = db.from('reward_redemptions').select('*').eq('family_id', FAMILY);
    if (after) q = q.gt('id', after);
    return q.order('id').limit(limit) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
  };
};

describe('a ledger read on the key counts each row once', () => {
  it('a row written ahead of the next page is not read twice, and none is dropped', async () => {
    const db = ledger(1500);
    // Between page 1 and page 2: a new request lands below the cursor, and a
    // row page 1 already read is deleted — the two writes that shift offsets.
    const { rows, error } = await readAllById<Row>(byKey(db, (n) => {
      if (n !== 2) return;
      db.seed('reward_redemptions', [{ id: 'r-0000a', family_id: FAMILY, cost_points: 500, status: 'requested' }]);
      db.table('reward_redemptions').splice(db.table('reward_redemptions').findIndex((r) => r.id === id(1)), 1);
    }), { max: 50_000 });

    expect(error).toBeNull();
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1500 }, (_, i) => id(i)));
  });

  it('the same interleaving, paged on offsets, repeats a row — the defect', async () => {
    const db = ledger(1500);
    let n = 0;
    const { rows } = await readAll<Row>((from, to) => {
      if (++n === 2) db.seed('reward_redemptions', [{ id: 'r-0000a', family_id: FAMILY, cost_points: 500, status: 'requested' }]);
      return db.from('reward_redemptions').select('*').eq('family_id', FAMILY).order('id').range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
    }, { max: 50_000 });

    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('a page that does not climb past the last id is refused, not appended or looped on', async () => {
    const db = ledger(1200);
    // The caller forgot the key filter: page 2 is page 1 again.
    const { rows, error } = await readAllById<Row>((_after, limit) =>
      db.from('reward_redemptions').select('*').eq('family_id', FAMILY).order('id').limit(limit) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
    { max: 50_000 });

    expect(error?.message).toMatch(/did not climb/);
    expect(rows).toHaveLength(1000);
  });

  it('exactly the ceiling is complete; one past it is a failed read unless the caller lists a prefix', async () => {
    expect(await readAllById<Row>(byKey(ledger(1000)), { max: 1000 })).toMatchObject({ error: null, truncated: false });
    const over = await readAllById<Row>(byKey(ledger(1001)), { max: 1000 });
    expect(over.truncated).toBe(true);
    expect(over.error?.message).toMatch(/PREFIX/);
    expect(over.rows).toHaveLength(1000);
    expect(await readAllById<Row>(byKey(ledger(1001)), { max: 1000, failOnMax: false })).toMatchObject({ error: null, truncated: true });
  });

  it('a failed or thrown page is a failed read, and the query shape answers data: null', async () => {
    const refused = await readAllByIdAsQuery<Row>(async () => ({ data: null, error: { message: 'permission denied' } }));
    expect(refused).toMatchObject({ data: null, error: { message: 'permission denied' } });
    const thrown = await readAllByIdAsQuery<Row>(async () => { throw new TypeError('fetch failed'); });
    expect(thrown).toMatchObject({ data: null, error: { message: 'fetch failed' } });
  });
});
