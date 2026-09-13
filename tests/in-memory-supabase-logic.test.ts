import { describe, expect, it } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const seeded = () => {
  const db = createInMemorySupabase();
  db.seed('items', [
    { id: 'a', family_id: 'own', done: false, value: 1, label: 'one', optional: null },
    { id: 'b', family_id: 'own', done: true, value: 2, label: 'two', optional: 'yes' },
    { id: 'c', family_id: 'own', done: false, value: 3, label: 'three', optional: 'yes' },
    { id: 'other', family_id: 'other', done: true, value: 2, label: 'two', optional: null },
  ]);
  return db;
};

describe('in-memory PostgREST logical filters', () => {
  it('compares JSON objects independent of key order while retaining arrays and scalar types', async () => {
    const db = createInMemorySupabase();
    db.seed('items', [{ id: 'a', payload: { state: 'ready', values: [1, '2'], meta: { x: true, y: null } } }]);
    const query = (value: unknown) => db.from('items').select('id').eq('payload', JSON.stringify(value));
    expect((await query({ meta: { y: null, x: true }, values: [1, '2'], state: 'ready' })).data).toEqual([{ id: 'a' }]);
    expect((await query({ state: 'ready', values: ['2', 1], meta: { x: true, y: null } })).data).toEqual([]);
    expect((await query({ state: 'ready', values: [1, 2], meta: { x: true, y: null } })).data).toEqual([]);
    expect((await query({ state: 'ready', values: [1, '2'] })).data).toEqual([]);
    expect((await db.from('items').select('id').eq('payload', '[object Object]')).data).toEqual([]);
  });
  it('applies exact text extraction to a JSON member before a conditional update', async () => {
    const db = createInMemorySupabase();
    db.seed('items', [{ id: 'a', payload: { revision: 'old', nested: { source: 'manual' } } }, { id: 'b', payload: { revision: 'new' } }, { id: 'missing', payload: {} }]);
    const changed = await db.from('items').update({ changed: true }, { count: 'exact' }).eq('payload->>revision', 'old').select('id').retry(false);
    expect(changed.data).toEqual([{ id: 'a' }]);
    expect(changed.count).toBe(1);
    expect(db.table('items').filter(row => row.changed)).toHaveLength(1);
    expect((await db.from('items').select('id').is('payload->>revision', null)).data).toEqual([{ id: 'missing' }]);
    expect((await db.from('items').select('id').eq('payload->nested->>source', 'manual')).data).toEqual([{ id: 'a' }]);
    expect(() => db.from('items').eq('payload->>nested->>revision', 'old')).toThrow('unsupported JSON path');
    expect(() => db.from('items').retry(true)).toThrow('retries are unsupported');
  });
  it('applies OR-of-AND groups before ordering, projection and a shared limit', async () => {
    const result = await seeded().from('items').select('id').eq('family_id', 'own')
      .or('and(done.eq.false,value.gte.3),and(done.eq.true,value.lt.3)').order('value', { ascending: false }).limit(1);
    expect(result.data).toEqual([{ id: 'c' }]);
  });
  it('supports nested conjunctions without admitting a partially matched branch', async () => {
    const result = await seeded().from('items').select('id').eq('family_id', 'own')
      .or('and(value.gte.1,and(done.eq.false,value.lt.3)),label.eq.two').order('value');
    expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
  it.each([
    ['optional.is.null,label.eq.three', ['a', 'c']],
    ['label.in.(one,three),value.eq.2', ['a', 'b', 'c']],
    ['not.done.eq.true,label.eq.two', ['a', 'b', 'c']],
    ['label.ilike.%THREE%,value.gt.4', ['c']],
    ['value.gte.2,value.lt.2', ['a', 'b', 'c']],
    ['not.and(done.eq.false,value.lt.3)', ['b', 'c']],
  ])('preserves flat operators and negation: %s', async (filter, ids) => {
    const result = await seeded().from('items').select('id').eq('family_id', 'own').or(filter).order('value');
    expect(result.data).toEqual(ids.map(id => ({ id })));
  });
  it.each(['and()', 'and(done.eq.true,)', ',done.eq.true', 'done.eq.true,', 'and(done.eq.true', 'done.eq.true)', 'and(value.unknown.1)', 'or(done.eq.true,value.eq.1)'])('rejects unsupported or malformed grammar: %s', filter => {
    expect(() => seeded().from('items').select('id').or(filter)).toThrow();
  });
});
