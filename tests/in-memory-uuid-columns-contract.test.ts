// The in-memory database refuses a value a uuid column cannot hold — the way
// Postgres does, with 22P02, before any row is touched.
//
// Why this exists: tests/helpers/in-memory-supabase.ts stored whatever text it
// was handed. A `<rule id>:<YYYY-MM-DD>` allowance key written to
// `wallet_transactions.related_id` — a uuid column (0088) — looked like a landed
// credit in every test and was refused by the database every night, after the
// run's claim had already moved the schedule on: the child was never paid, and
// no test could see it. With `uuidColumns` declared, a fixture states which
// columns are typed, and the fake answers a composite key there exactly as the
// server does. `uniques` reads a JSON path (`metadata->>occurrence`) too, so the
// owner's expression index over the key that now rides in jsonb can be modelled.
import { describe, expect, it } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const RULE = '70000000-0000-4000-8000-000000000001';
const OTHER = '70000000-0000-4000-8000-000000000002';
const KEY = `${RULE}:2026-10-20`;
const REFUSED = { code: '22P02', message: `invalid input syntax for type uuid: "${KEY}"` };

const typed = () => createInMemorySupabase({ uuidColumns: { ledger: ['related_id', 'bucket_id'] } });

describe('a uuid column (InMemoryOptions.uuidColumns)', () => {
  it('refuses a composite key on insert with 22P02 and writes nothing', async () => {
    const db = typed();
    const reply = await db.from('ledger').insert({ family_id: 'f', related_id: KEY, amount_cents: 1 }).select('id');
    expect(reply.data).toBeNull();
    expect(reply.error).toMatchObject(REFUSED);
    expect(db.table('ledger')).toEqual([]);
  });

  it('a multi-row insert with one bad row writes no row', async () => {
    const db = typed();
    const reply = await db.from('ledger').insert([
      { family_id: 'f', related_id: RULE, amount_cents: 1 },
      { family_id: 'f', related_id: KEY, amount_cents: 2 },
    ]);
    expect(reply.error).toMatchObject({ code: '22P02' });
    expect(db.table('ledger')).toEqual([]);
  });

  it('accepts a uuid, a braced or unhyphenated uuid, and null', async () => {
    const db = typed();
    const reply = await db.from('ledger').insert([
      { related_id: RULE },
      { related_id: `{${RULE}}` },
      { related_id: RULE.replace(/-/g, '') },
      { related_id: null },
      { amount_cents: 3 },
    ]).select('id');
    expect(reply.error).toBeNull();
    expect(db.table('ledger')).toHaveLength(5);
  });

  it('refuses the same key on update and upsert, leaving the row as it was', async () => {
    const db = typed();
    db.seed('ledger', [{ id: RULE, related_id: OTHER }]);
    const updated = await db.from('ledger').update({ related_id: KEY }).eq('id', RULE).select('id');
    expect(updated.error).toMatchObject({ code: '22P02' });
    const upserted = await db.from('ledger').upsert({ id: RULE, related_id: KEY });
    expect(upserted.error).toMatchObject({ code: '22P02' });
    expect(db.table('ledger')[0]).toMatchObject({ related_id: OTHER });
  });

  it('refuses the same key as a filter value: the read fails, it does not answer "not found"', async () => {
    const db = typed();
    db.seed('ledger', [{ related_id: RULE }]);
    const read = await db.from('ledger').select('id').eq('related_id', KEY).limit(1);
    expect(read.data).toBeNull();
    expect(read.error).toMatchObject(REFUSED);
    for (const query of [
      db.from('ledger').select('id').in('related_id', [RULE, KEY]),
      db.from('ledger').select('id').neq('related_id', KEY),
      db.from('ledger').select('id').not('related_id', 'eq', KEY),
      db.from('ledger').select('id').filter('related_id', 'eq', KEY),
      db.from('ledger').update({ amount_cents: 2 }).eq('related_id', KEY).select('id'),
      db.from('ledger').delete().eq('related_id', KEY).select('id'),
    ]) {
      expect((await query).error).toMatchObject({ code: '22P02' });
    }
    expect(db.table('ledger')).toHaveLength(1);
  });

  it('answers a uuid filter from the table, and leaves undeclared columns untyped', async () => {
    const db = typed();
    db.seed('ledger', [{ id: OTHER, related_id: RULE, note: 'a:b' }]);
    expect((await db.from('ledger').select('id').eq('related_id', RULE)).data).toEqual([{ id: OTHER }]);
    expect((await db.from('ledger').select('id').eq('related_id', null)).data).toEqual([]);
    expect((await db.from('ledger').select('id').eq('note', 'a:b')).data).toEqual([{ id: OTHER }]);
    expect((await db.from('ledger').insert({ note: KEY, related_id: null })).error).toBeNull();
  });

  it('throws on a seed row the real table could not hold', () => {
    const db = typed();
    expect(() => db.seed('ledger', [{ related_id: KEY }])).toThrow(/seed ledger\.related_id: invalid input syntax for type uuid/);
    expect(db.table('ledger')).toEqual([]);
  });

  it('a database without the option keeps storing anything (control)', async () => {
    const db = createInMemorySupabase();
    expect((await db.from('ledger').insert({ related_id: KEY })).error).toBeNull();
    expect((await db.from('ledger').select('related_id').eq('related_id', KEY)).data).toEqual([{ related_id: KEY }]);
  });
});

describe('a unique key over a JSON path (uniques)', () => {
  const indexed = () => createInMemorySupabase({
    uniques: { ledger: [['family_id', 'related_type', 'related_id', 'metadata->>occurrence', 'bucket_id']] },
  });

  it('refuses a second row with the same occurrence under the same rule and bucket', async () => {
    const db = indexed();
    const row = { family_id: 'f', related_type: 'allowance_rules', related_id: RULE, bucket_id: 'b', metadata: { split: { spend: 100 }, occurrence: KEY } };
    expect((await db.from('ledger').insert(row)).error).toBeNull();
    const again = await db.from('ledger').insert({ ...row, metadata: { occurrence: KEY, split: { spend: 50 } } });
    expect(again.error).toMatchObject({ code: '23505' });
    expect(db.table('ledger')).toHaveLength(1);
  });

  it('lets another occurrence, another bucket and a row without the member through', async () => {
    const db = indexed();
    const row = { family_id: 'f', related_type: 'allowance_rules', related_id: RULE, bucket_id: 'b', metadata: { occurrence: KEY } };
    expect((await db.from('ledger').insert(row)).error).toBeNull();
    expect((await db.from('ledger').insert({ ...row, metadata: { occurrence: `${RULE}:2026-10-27` } })).error).toBeNull();
    expect((await db.from('ledger').insert({ ...row, bucket_id: 'c' })).error).toBeNull();
    expect((await db.from('ledger').insert({ ...row, metadata: { split: {} } })).error).toBeNull();
    expect((await db.from('ledger').insert({ ...row, metadata: { split: {} } })).error).toBeNull();
    expect(db.table('ledger')).toHaveLength(5);
  });
});
