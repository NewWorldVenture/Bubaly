// Behavioural tests for the groceries service — the one implementation that
// replaces the four divergent "get or create the list" copies in the repo.
// Covers: a single default list, aisle categorisation, deduplication against
// what is still unbought, family scoping, and honest error surfacing.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  addItems,
  categorizeGroceryItem,
  checkItem,
  clearChecked,
  ensureDefaultList,
  listOpen,
  planGroceryNeeds,
  addFromMealPlan,
} from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';

afterEach(() => vi.restoreAllMocks());

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    now: new Date('2026-09-05T12:00:00Z'),
    ...extra,
  };
}

describe('categorizeGroceryItem', () => {
  it('maps common items to a store aisle', () => {
    expect(categorizeGroceryItem('2% Milk')).toBe('Dairy');
    expect(categorizeGroceryItem('bananas')).toBe('Produce');
    expect(categorizeGroceryItem('chicken thighs')).toBe('Meat & Seafood');
    expect(categorizeGroceryItem('sourdough bread')).toBe('Bakery');
    expect(categorizeGroceryItem('toilet paper')).toBe('Household');
  });

  it('prefers the longer keyword when two could match', () => {
    // 'peanut butter' beats 'butter', so it lands in Pantry rather than Dairy.
    expect(categorizeGroceryItem('peanut butter')).toBe('Pantry');
  });

  it('returns null rather than guessing an aisle', () => {
    expect(categorizeGroceryItem('birthday candles')).toBeNull();
  });
});

describe('ensureDefaultList', () => {
  it('reuses the oldest un-archived list', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'list-1' }, error: null }));
    const res = await ensureDefaultList(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'list-1', created: false } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', is_archived: false });
  });

  it('creates one named Groceries with the auth user id', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: { id: 'list-new' }, error: null } : { data: null, error: null }));
    const res = await ensureDefaultList(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'list-new', created: true } });
    // grocery_lists.created_by references auth.users (0002).
    expect(calls.find((c) => c.kind === 'insert')?.payload).toEqual({
      family_id: 'fam-1', name: 'Groceries', created_by: 'auth-user-1',
    });
  });

  it('surfaces a lookup failure instead of creating a second list', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: { message: 'timeout' } }));
    const res = await ensureDefaultList(scopeWith(db));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });
});

describe('addItems', () => {
  it('categorises each item and stamps the family and list', async () => {
    let saved: Record<string, unknown>[] = [];
    const { db, calls } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      if (call.kind === 'select' && call.filters.id) return { data: saved, error: null };
      if (call.kind === 'select') return { data: [], error: null };
      if (call.table !== 'grocery_items') return { data: { id: 'other' }, error: null };
      saved = (call.payload as Record<string, unknown>[]).map((row, i) => ({ ...row, id: `item-${i}` }));
      return { data: saved, error: null };
    });

    const res = await addItems(scopeWith(db), { items: [{ name: 'milk', quantity: '2' }, { name: 'bananas' }] });
    expect(res.ok).toBe(true);
    const rows = calls.find((c) => c.table === 'grocery_items' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      family_id: 'fam-1', list_id: 'list-1', name: 'milk', quantity: '2', category: 'Dairy', created_by: 'auth-user-1',
    });
    expect(rows[1]).toMatchObject({ name: 'bananas', category: 'Produce', quantity: null });
  });

  it('skips an item already on the list unbought, matching case and plurals', async () => {
    let saved: Record<string, unknown>[] = [];
    const { db, calls } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      if (call.kind === 'select' && call.filters.id) return { data: saved, error: null };
      if (call.kind === 'select') return { data: [{ name: 'Milk' }], error: null };
      if (call.table !== 'grocery_items') return { data: { id: 'other' }, error: null };
      saved = (call.payload as Record<string, unknown>[]).map((row, i) => ({ ...row, id: `item-${i}` }));
      return { data: saved, error: null };
    });

    const res = await addItems(scopeWith(db), { items: [{ name: 'milks' }, { name: 'eggs' }] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.skipped).toEqual(['milks']);
    const rows = calls.find((c) => c.table === 'grocery_items' && c.kind === 'insert')?.payload as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('eggs');
  });

  it('only compares against unbought items in this family', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      if (call.kind === 'select') return { data: [], error: null };
      return { data: [{ id: 'item-1' }], error: null };
    });
    await addItems(scopeWith(db), { items: [{ name: 'milk' }] });
    const probe = calls.find((c) => c.table === 'grocery_items' && c.kind === 'select');
    expect(probe?.filters).toMatchObject({ family_id: 'fam-1', list_id: 'list-1', is_checked: false });
  });

  it('writes nothing when every item is already on the list', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      return { data: [{ name: 'milk' }], error: null };
    });
    const res = await addItems(scopeWith(db), { items: [{ name: 'Milk' }] });
    expect(res).toMatchObject({ ok: true, data: { added: [], skipped: ['Milk'] } });
    expect(calls.some((c) => c.table === 'grocery_items' && c.kind === 'insert')).toBe(false);
  });

  it('rejects an empty request without touching the database', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await addItems(scopeWith(db), { items: [{ name: '  ' }] });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces an insert failure', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      if (call.kind === 'select') return { data: [], error: null };
      return { data: null, error: { code: '42501', message: 'permission denied' } };
    });
    const res = await addItems(scopeWith(db), { items: [{ name: 'milk' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("don't have permission");
  });

  it('records agent activity when the assistant adds items', async () => {
    let saved: Record<string, unknown>[] = [];
    const { db, calls } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      if (call.kind === 'select' && call.filters.id) return { data: saved, error: null };
      if (call.table === 'grocery_items' && call.kind === 'select') return { data: [], error: null };
      if (call.table === 'agent_activity') return { data: { id: 'act-1' }, error: null };
      if (call.table !== 'grocery_items') return { data: { id: 'other' }, error: null };
      saved = (call.payload as Record<string, unknown>[]).map((row, i) => ({ ...row, id: `item-${i}` }));
      return { data: saved, error: null };
    });
    await addItems(scopeWith(db, { actorKind: 'ai' }), { items: [{ name: 'milk' }] });
    const activity = calls.find((c) => c.table === 'agent_activity');
    expect(activity?.payload).toMatchObject({ family_id: 'fam-1', agent: 'groceries', kind: 'action' });
  });
});

describe('listOpen', () => {
  it('treats a family with no list yet as an empty list, not an error', async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));
    const res = await listOpen(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { listId: null, items: [] } });
  });

  it('reads only unchecked items in the family', async () => {
    const { db, calls } = makeDb((call) => (call.table === 'grocery_lists'
      ? { data: { id: 'list-1' }, error: null }
      : { data: [{ id: 'item-1' }], error: null }));
    const res = await listOpen(scopeWith(db));
    expect(res.ok).toBe(true);
    const items = calls.find((c) => c.table === 'grocery_items');
    expect(items?.filters).toMatchObject({ family_id: 'fam-1', list_id: 'list-1', is_checked: false });
  });
});

describe('meal ingredient quantities and verified grocery persistence', () => {
  function memory() {
    const db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
      grocery_lists: { is_archived: false, archived_at: null },
      grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
    } });
    db.seed('grocery_lists', [{ id: 'list-1', family_id: 'fam-1' }, { id: 'foreign', family_id: 'other' }]);
    return db;
  }

  it('counts repeated meals and identical quantities without substring deduplication', () => {
    const dish = { id: 'dish', name: 'Soup', ingredients: [{ name: 'beans', quantity: '1', unit: 'cup' }] };
    const result = planGroceryNeeds([dish, dish, { ...dish, ingredients: [
      { name: 'tomato', quantity: '12', unit: 'oz' }, { name: 'tomato', quantity: '2', unit: 'oz' },
    ] }], []);
    expect(result.needed).toEqual([
      { name: 'beans', quantity: '1 cup + 1 cup', sourceMealId: 'dish' },
      { name: 'tomato', quantity: '12 oz + 2 oz', sourceMealId: 'dish' },
    ]);
  });

  it('preserves fractions, ranges, descriptors, unit-only entries and unknown amounts', () => {
    const result = planGroceryNeeds([{ id: 'dish', name: 'Bake', ingredients: [
      { name: 'flour', quantity: '1 1/2', unit: 'cups' }, { name: 'flour', quantity: '1/2', unit: 'cup' },
      { name: 'herbs', quantity: null, unit: 'handful' }, { name: 'salt', quantity: 'to taste', unit: null },
      { name: 'eggs', quantity: '2–3', unit: null }, { name: 'water', quantity: null, unit: null },
      { name: 'water', quantity: '1', unit: 'cup' },
    ] }], []);
    expect(result.needed.map((line) => line.quantity)).toEqual(['1 1/2 cups + 1/2 cup', 'handful', 'to taste', '2–3', 'amount unspecified + 1 cup']);
  });

  it('refuses a supplied foreign list before adding items', async () => {
    const db = memory();
    expect(await addItems(scopeWith(db), { listId: 'foreign', items: [{ name: 'milk' }] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('grocery_items')).toHaveLength(0);
  });

  it('rejects an incomplete insert receipt and does not record success', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
      return { data: [], error: null };
    });
    expect(await addItems(scopeWith(db), { items: [{ name: 'milk' }] })).toMatchObject({ ok: false, code: 'db' });
  });

  it('rejects equal-count altered data and missing independent readback', async () => {
    for (const wrongReceipt of [true, false]) {
      const { db, calls } = makeDb((call) => {
        if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
        if (call.kind === 'insert') return { data: (call.payload as Record<string, unknown>[]).map((row) => ({
          ...row, id: 'item-1', ...(wrongReceipt ? { quantity: 'wrong' } : {}),
        })), error: null };
        return { data: [], error: null };
      });
      expect((await addItems(scopeWith(db, { actorKind: 'ai' }), { items: [{ name: 'milk', quantity: '2' }] })).ok).toBe(false);
      expect(calls.some((call) => call.table === 'agent_activity')).toBe(false);
    }
  });

  it('expands repeated planned dishes into persisted additive quantities and safely skips a retry', async () => {
    const db = memory();
    db.seed('meal_plans', [
      { family_id: 'fam-1', meal_id: 'soup', plan_date: '2026-09-07' },
      { family_id: 'fam-1', meal_id: 'soup', plan_date: '2026-09-08' },
    ]);
    db.seed('meals', [{ id: 'soup', family_id: 'fam-1', name: 'Soup', ingredients: [{ name: 'beans', qty: '1', unit: 'cup' }] }]);
    const first = await addFromMealPlan(scopeWith(db), { from: '2026-09-07', to: '2026-09-13', listId: 'list-1' });
    expect(first).toMatchObject({ ok: true, data: { added: [{ name: 'beans', quantity: '1 cup + 1 cup' }] } });
    const second = await addFromMealPlan(scopeWith(db), { from: '2026-09-07', to: '2026-09-13', listId: 'list-1' });
    expect(second).toMatchObject({ ok: true, data: { added: [], skipped: ['beans'] } });
    expect(db.table('grocery_items')).toHaveLength(1);
  });

  it('keeps complete weekly quantities when pantry skipping is disabled, even with insufficient or unmeasured stock', async () => {
    const db = memory();
    db.seed('meal_plans', [
      { family_id: 'fam-1', meal_id: 'soup', plan_date: '2026-09-07' },
      { family_id: 'fam-1', meal_id: 'soup', plan_date: '2026-09-08' },
    ]);
    db.seed('meals', [{ id: 'soup', family_id: 'fam-1', name: 'Soup', ingredients: [
      { name: 'beans', qty: '1', unit: 'cup' }, { name: 'rice', qty: '1/2', unit: 'cup' },
    ] }]);
    db.seed('pantry_items', [
      { family_id: 'fam-1', name: 'beans', quantity: 0.1, unit: 'cup' },
      { family_id: 'fam-1', name: 'rice', quantity: 1, unit: null },
    ]);
    const result = await addFromMealPlan(scopeWith(db), { from: '2026-09-07', to: '2026-09-13', usePantry: false });
    expect(result).toMatchObject({ ok: true, data: { inPantry: [], substitutions: [], added: [
      { name: 'beans', quantity: '1 cup + 1 cup' }, { name: 'rice', quantity: '1/2 cup + 1/2 cup' },
    ] } });
    expect(db.log.some((call) => call.table === 'pantry_items')).toBe(false);
  });

  it('reports ingredientless or unreadable planned dishes before adding a partial shopping list', async () => {
    for (const missingRow of [true, false]) {
      const db = memory();
      db.seed('meal_plans', [{ family_id: 'fam-1', meal_id: 'unknown', plan_date: '2026-09-07' }]);
      if (!missingRow) db.seed('meals', [{ id: 'unknown', family_id: 'fam-1', name: 'Takeout', ingredients: [] }]);
      const result = await addFromMealPlan(scopeWith(db), { from: '2026-09-07', to: '2026-09-13' });
      expect(result.ok).toBe(false);
      expect(db.table('grocery_items')).toHaveLength(0);
    }
  });

  it('verifies list ownership even when all ingredients are in the pantry', async () => {
    const db = memory();
    db.seed('meal_plans', [{ family_id: 'fam-1', meal_id: 'soup', plan_date: '2026-09-07' }]);
    db.seed('meals', [{ id: 'soup', family_id: 'fam-1', name: 'Soup', ingredients: [{ name: 'beans', qty: '1' }] }]);
    db.seed('pantry_items', [{ family_id: 'fam-1', name: 'beans', quantity: 1 }]);
    expect(await addFromMealPlan(scopeWith(db), { from: '2026-09-07', listId: 'foreign' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('checkItem / clearChecked', () => {
  it('scopes the tick to the family and reports a foreign id as not found', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await checkItem(scopeWith(db), 'item-elsewhere');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ id: 'item-elsewhere', family_id: 'fam-1' });
  });

  it('removes only checked items on the given list', async () => {
    const { db, calls } = makeDb(() => ({ data: [{ id: 'a' }, { id: 'b' }], error: null }));
    const res = await clearChecked(scopeWith(db), 'list-1');
    expect(res).toEqual({ ok: true, data: { removed: 2 } });
    expect(calls[0].kind).toBe('delete');
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', list_id: 'list-1', is_checked: true });
  });
});
