// Behavioural tests for the meals service against a hand-written Supabase
// fake. The headline is `planWeek`'s rollback: a failed insert must put the
// previous slots back and remove any dish the call created, so a failed
// replan is a no-op rather than an empty week. The rest pins the column
// choices (auth user id in `created_by`), family scoping on every query, the
// per-meal-type slot clearing, and the pure helpers the planner relies on.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  classifyFoodFact,
  createRecipe,
  ensureMealByName,
  foodProfile,
  getMealPlan,
  isDayKey,
  parseIngredients,
  planWeek,
  removeSlot,
  setSlot,
  weekDayKeys,
} from '@/lib/services/meals';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const index = calls.length - 1;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    // PostgREST's `.range()` is inclusive at both ends, and a page that starts
    // past the last row comes back EMPTY — which is the only signal that tells a
    // paged read it has reached the end. A fake that ignored the window would
    // hand `readAll` the same page forever, so model it.
    let window: { from: number; to: number } | null = null;
    const paged = (reply: Reply): Reply => (window && Array.isArray(reply.data)
      ? { ...reply, data: reply.data.slice(window.from, window.to + 1) }
      : reply);
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      range: (from: number, to: number) => { window = { from, to }; return b; },
      eq: filter, is: filter, in: filter,
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call, index)),
      maybeSingle: () => Promise.resolve(respond(call, index)),
      then: (resolve: (value: Reply) => void) => resolve(paged(respond(call, index))),
    });
    return b;
  };
  // `foodProfile` reads allergies through the `family_allergies` RPC (0438), not
  // a select on `medical_profiles`. Logged as `rpc:<name>` with its arguments in
  // `filters`, so a test can assert which family was asked about.
  const rpc = (name: string, args: Record<string, unknown> = {}) => {
    const call: Call = { table: `rpc:${name}`, kind: 'select', filters: { ...args } };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  };
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra,
  };
}

const MEAL = (id: string, name: string, ingredients: unknown[] = []) => ({
  id, family_id: 'fam-1', name, meal_type: 'dinner', recipe_url: null, image_url: null,
  ingredients, notes: null, created_by: 'auth-user-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
});

afterEach(() => vi.restoreAllMocks());

function memoryDb() {
  return createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { ingredients: [], recipe_url: null, image_url: null, meal_type: 'dinner' },
    meal_plans: { meal_id: null, idempotency_key: null },
  } });
}

/** Intercept one public builder operation while retaining real filter/readback behavior. */
describe('pure helpers', () => {
  it('produces seven consecutive UTC-safe day keys', () => {
    expect(weekDayKeys('2026-09-07')).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ]);
    // Crosses a month boundary without local-time drift.
    expect(weekDayKeys('2026-09-28')[3]).toBe('2026-10-01');
  });

  it('accepts only real calendar days', () => {
    expect(isDayKey('2026-09-07')).toBe(true);
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('next tuesday')).toBe(false);
    expect(isDayKey(20260907)).toBe(false);
  });

  it('reads both ingredient dialects and drops junk', () => {
    expect(parseIngredients([
      { name: 'onion', qty: 2, unit: null },
      { name: 'flour', quantity: '1', unit: 'cup' },
      'salt',
      { qty: '3' },
      null,
    ])).toEqual([
      { name: 'onion', quantity: '2', unit: null },
      { name: 'flour', quantity: '1', unit: 'cup' },
      { name: 'salt', quantity: null, unit: null },
    ]);
    expect(parseIngredients('not a list' as never)).toEqual([]);
  });

  it('sorts preference facts into the buckets a planner needs', () => {
    expect(classifyFoodFact("Doesn't eat", 'mushrooms')).toBe('dislikes');
    expect(classifyFoodFact('Diet', 'vegetarian')).toBe('diet');
    expect(classifyFoodFact('Favourite dinner', 'Taco night')).toBe('favorites');
    expect(classifyFoodFact('Allergy', 'peanuts')).toBe('allergies');
    expect(classifyFoodFact('Bedtime', '8pm')).toBeNull();
  });
});

describe('ensureMealByName', () => {
  it('retains an explicitly chosen library meal type when a same-name dish has another type', async () => {
    const db = memoryDb();
    db.seed('meals', [{ ...MEAL('breakfast-toast', 'Toast'), meal_type: 'breakfast' }]);
    const result = await ensureMealByName(scopeWith(db), { name: 'Toast', mealType: 'dinner', ingredients: [] });
    expect(result).toMatchObject({ ok: true, data: { created: true, meal: { meal_type: 'dinner' } } });
  });

  it('reuses the matching ingredient variant on retry without modifying the older dish', async () => {
    const db = memoryDb();
    db.seed('meals', [MEAL('empty-tacos', 'Tacos')]);
    const input = { name: 'Tacos', ingredients: [{ name: 'beans', quantity: '1/2', unit: 'cup' }], recipeUrl: 'https://example.com/tacos' };
    const first = await ensureMealByName(scopeWith(db), input);
    const retry = await ensureMealByName(scopeWith(db), input);
    expect(first).toMatchObject({ ok: true, data: { created: true } });
    expect(retry).toMatchObject({ ok: true, data: { created: false } });
    if (first.ok && retry.ok) expect(retry.data.meal.id).toBe(first.data.meal.id);
    expect(db.table('meals')).toHaveLength(2);
    expect(db.table('meals')[0].ingredients).toEqual([]);
  });

  it('rejects altered meal receipts and does not claim an unconfirmed readback succeeded', async () => {
    const { db } = makeDb((call) => {
      if (call.kind === 'insert') return { data: MEAL('new', 'Pasta'), error: null };
      return { data: [], error: null };
    });
    expect((await ensureMealByName(scopeWith(db), { name: 'Pasta', ingredients: [{ name: 'pasta', quantity: '1', unit: 'box' }] })).ok).toBe(false);
  });

  it('reuses an existing dish case-insensitively instead of inserting', async () => {
    const { db, calls } = makeDb(() => ({ data: [MEAL('meal-1', 'Tacos')], error: null }));
    const res = await ensureMealByName(scopeWith(db), { name: 'tacos' });
    expect(res.ok && !res.data.created && res.data.meal.id === 'meal-1').toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters.family_id).toBe('fam-1');
    expect(calls[0].filters['ilike:name']).toBe('tacos');
  });

  it('creates the dish with the auth user id in created_by', async () => {
    const db = memoryDb();
    const res = await ensureMealByName(scopeWith(db), { name: ' Ramen ', mealType: 'lunch', ingredients: [{ name: 'noodles', quantity: '1', unit: 'pack' }] });
    expect(res.ok && res.data.created).toBe(true);
    expect(db.table('meals')[0]).toMatchObject({
      family_id: 'fam-1', name: 'Ramen', meal_type: 'lunch', created_by: 'auth-user-1',
      ingredients: [{ name: 'noodles', qty: '1', unit: 'pack' }],
    });
  });
});

describe('planWeek / setSlot atomic persistence', () => {
  const plannedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'planned-1', family_id: 'fam-1', meal_id: 'tacos', plan_date: '2026-09-07', meal_type: 'dinner',
    created_by: 'auth-user-1', idempotency_key: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...overrides,
  });
  const plannedSlot = { id: 'planned-1', date: '2026-09-07', mealType: 'dinner', mealId: 'tacos', name: 'Tacos',
    ingredients: [{ name: 'tortilla', quantity: '8', unit: null }] };
  const entries = [{ date: '2026-09-07', mealType: 'dinner' as const, mealId: 'tacos' }];

  function atomicDb(options: { rpcData?: unknown; rpcError?: unknown; readback?: unknown[] } = {}) {
    const saved = options.readback ?? [plannedRow()];
    return makeDb((call) => {
      if (call.table === 'meals' && call.filters.id === 'tacos') return { data: MEAL('tacos', 'Tacos', [{ name: 'tortilla', qty: '8' }]), error: null };
      if (call.table === 'meals' && Array.isArray(call.filters.id)) return { data: [MEAL('tacos', 'Tacos', [{ name: 'tortilla', qty: '8' }])], error: null };
      if (call.table === 'rpc:meal_plan_replace_slots') return { data: Object.hasOwn(options, 'rpcData') ? options.rpcData : { planned: [plannedRow()], replaced: 1, replayed: false }, error: options.rpcError ?? null };
      if (call.table === 'rpc:meal_plan_remove_slot') return { data: Object.hasOwn(options, 'rpcData') ? options.rpcData : { id: 'planned-1', plan_date: '2026-09-07', meal_type: 'dinner', replayed: false }, error: options.rpcError ?? null };
      if (call.table === 'meal_plans') return { data: saved, error: null };
      return { data: null, error: null };
    });
  }

  it('rejects malformed entries, conflicting sources, invalid links and duplicate slots before writes', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const invalid = [[], [null], [{ date: 'monday', mealName: 'Tacos' }], [{ date: '2026-09-07' }],
      [{ date: '2026-09-07', mealId: 'a', mealName: 'Tacos' }], [{ date: '2026-09-07', recipeId: 'r', ingredients: [] }],
      [{ date: '2026-09-07', mealName: 42 }], [{ date: '2026-09-07', mealName: 'Tacos', ingredients: [null] }],
      [{ date: '2026-09-07', mealName: 'Tacos', recipeUrl: 'javascript:alert(1)' }],
      [{ date: '2026-09-07', mealName: 'Tacos' }, { date: '2026-09-07', mealName: 'Curry' }]];
    for (const input of invalid) expect(await planWeek(scopeWith(db), input as never)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('replaces the precise requested slots through the atomic RPC and confirms the stored meal details', async () => {
    const { db, calls } = atomicDb();
    const result = await planWeek(scopeWith(db, { actorKind: 'ai' }), entries, 'retryable-request');
    expect(result).toMatchObject({ ok: true, data: { replaced: 1, createdMeals: 0, planned: [plannedSlot] } });
    expect(calls.find((call) => call.table === 'rpc:meal_plan_replace_slots')?.filters).toEqual({
      p_family_id: 'fam-1', p_request_id: 'retryable-request',
      p_entries: [{ meal_id: 'tacos', plan_date: '2026-09-07', meal_type: 'dinner' }],
    });
    expect(calls.some((call) => call.table === 'meal_plans' && (call.kind === 'insert' || call.kind === 'delete'))).toBe(false);
  });

  it('uses a stable receipt key derived from the scoped AI request on retry', async () => {
    const { db, calls } = atomicDb();
    const scope = scopeWith(db, { actorKind: 'ai', requestId: 'originating-request' });
    const first = await planWeek(scope, entries);
    const second = await planWeek(scope, entries);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const requestIds = calls.filter((call) => call.table === 'rpc:meal_plan_replace_slots').map((call) => call.filters.p_request_id);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it('keeps the request key fixed when the scoped retry payload changes', async () => {
    const { db, calls } = atomicDb();
    const scope = scopeWith(db, { actorKind: 'ai', idempotencyKey: 'tool-call-key' });
    await planWeek(scope, entries);
    await planWeek(scope, [{ ...entries[0], date: '2026-09-08' }]);
    const requestIds = calls.filter((call) => call.table === 'rpc:meal_plan_replace_slots').map((call) => call.filters.p_request_id);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it('reports an unknown RPC result without compensating or deleting newly resolved dishes', async () => {
    const { db, calls } = atomicDb({ rpcError: { message: 'connection lost after commit' } });
    const result = await planWeek(scopeWith(db), entries, 'lost-response-key');
    expect(result).toMatchObject({ ok: false, code: 'db', error: expect.stringContaining('Refresh') });
    expect(calls.filter((call) => call.table === 'meal_plans' && (call.kind === 'insert' || call.kind === 'delete'))).toEqual([]);
    expect(calls.some((call) => call.table === 'rpc:meal_plan_replace_slots')).toBe(true);
  });

  it.each([
    ['null response', null], ['missing planned rows', { replaced: 0, replayed: false }],
    ['non-array planned rows', { planned: {}, replaced: 0, replayed: false }],
    ['empty planned rows', { planned: [], replaced: 0, replayed: false }],
    ['negative replaced count', { planned: [plannedRow()], replaced: -1, replayed: false }],
    ['fractional replaced count', { planned: [plannedRow()], replaced: 1.5, replayed: false }],
    ['missing replay state', { planned: [plannedRow()], replaced: 1 }],
    ['wrong family', { planned: [plannedRow({ family_id: 'foreign' })], replaced: 1, replayed: false }],
    ['wrong actor', { planned: [plannedRow({ created_by: 'other-user' })], replaced: 1, replayed: false }],
    ['wrong meal', { planned: [plannedRow({ meal_id: 'other-meal' })], replaced: 1, replayed: false }],
    ['wrong date', { planned: [plannedRow({ plan_date: '2026-09-08' })], replaced: 1, replayed: false }],
    ['wrong meal type', { planned: [plannedRow({ meal_type: 'snack' })], replaced: 1, replayed: false }],
    ['empty ID', { planned: [plannedRow({ id: '' })], replaced: 1, replayed: false }],
  ])('refuses malformed or mismatched atomic receipt: %s', async (_label, rpcData) => {
    const { db, calls } = atomicDb({ rpcData });
    const result = await planWeek(scopeWith(db), entries, 'malformed-result');
    expect(result).toMatchObject({ ok: false, code: 'db', error: expect.stringContaining('Refresh') });
    expect(calls.some((call) => call.table === 'rpc:meal_plan_replace_slots')).toBe(true);
    expect(calls.some((call) => call.table === 'agent_activity' || call.table === 'audit_logs')).toBe(false);
  });

  it('does not report success or perform rollback if the post-commit confirmation differs', async () => {
    const { db, calls } = atomicDb({ readback: [] });
    const result = await planWeek(scopeWith(db), entries, 'readback-mismatch');
    expect(result).toMatchObject({ ok: false, code: 'db', error: expect.stringContaining('Refresh') });
    expect(calls.some((call) => call.table === 'meal_plans' && (call.kind === 'insert' || call.kind === 'delete'))).toBe(false);
    expect(calls.some((call) => call.table === 'audit_logs')).toBe(false);
  });

  it('setSlot exposes the same persisted ID and replacement status as planWeek', async () => {
    const result = await setSlot(scopeWith(atomicDb().db), entries[0], 'stable-slot-request');
    expect(result).toMatchObject({ ok: true, data: { ...plannedSlot, replaced: true } });
  });

  it('removeSlot requires a valid exact-ID receipt and records activity only on first commit', async () => {
    const { db, calls } = atomicDb();
    const result = await removeSlot(scopeWith(db), 'planned-1', 'remove-request');
    expect(result).toEqual({ ok: true, data: { id: 'planned-1' } });
    expect(calls.find((call) => call.table === 'rpc:meal_plan_remove_slot')?.filters).toMatchObject({
      p_family_id: 'fam-1', p_request_id: 'remove-request', p_plan_id: 'planned-1',
    });
    expect(calls.filter((call) => call.table === 'audit_logs')).toHaveLength(1);

    const bad = atomicDb({ rpcData: { id: 'somebody-elses-plan', replayed: false } });
    expect(await removeSlot(scopeWith(bad.db), 'planned-1', 'bad-remove')).toMatchObject({ ok: false, code: 'db' });

    const changedTarget = atomicDb();
    const keyedScope = scopeWith(changedTarget.db, { idempotencyKey: 'remove-tool-call' });
    await removeSlot(keyedScope, 'planned-1');
    await removeSlot(keyedScope, 'different-plan');
    const requestIds = changedTarget.calls.filter((call) => call.table === 'rpc:meal_plan_remove_slot').map((call) => call.filters.p_request_id);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it.each([
    ['missing date', { id: 'planned-1', meal_type: 'dinner', replayed: false }],
    ['null date', { id: 'planned-1', plan_date: null, meal_type: 'dinner', replayed: false }],
    ['numeric date', { id: 'planned-1', plan_date: 20260907, meal_type: 'dinner', replayed: false }],
    ['impossible date', { id: 'planned-1', plan_date: '2026-02-30', meal_type: 'dinner', replayed: false }],
    ['missing type', { id: 'planned-1', plan_date: '2026-09-07', replayed: false }],
    ['null type', { id: 'planned-1', plan_date: '2026-09-07', meal_type: null, replayed: false }],
    ['numeric type', { id: 'planned-1', plan_date: '2026-09-07', meal_type: 3, replayed: false }],
    ['unknown type', { id: 'planned-1', plan_date: '2026-09-07', meal_type: 'brunch', replayed: false }],
  ])('removeSlot refuses incomplete receipt fields: %s before recording activity', async (_label, rpcData) => {
    const { db, calls } = atomicDb({ rpcData });
    expect(await removeSlot(scopeWith(db), 'planned-1', 'incomplete-remove')).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((call) => call.table === 'rpc:meal_plan_remove_slot')).toBe(true);
    expect(calls.some((call) => call.table === 'agent_activity' || call.table === 'audit_logs')).toBe(false);
  });

  it('rejects a non-string remove request ID before calling the RPC', async () => {
    const { db, calls } = atomicDb();
    expect(await removeSlot(scopeWith(db), 'planned-1', 42 as never)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls.some((call) => call.table === 'rpc:meal_plan_remove_slot')).toBe(false);
  });
});describe('getMealPlan', () => {
  it('joins dishes onto the week and sorts by day then meal', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'meal_plans') {
        return {
          data: [
            { id: 'p1', family_id: 'fam-1', meal_id: 'meal-1', plan_date: '2026-09-08', meal_type: 'dinner', created_by: null },
            { id: 'p2', family_id: 'fam-1', meal_id: 'meal-2', plan_date: '2026-09-08', meal_type: 'breakfast', created_by: null },
            { id: 'p3', family_id: 'fam-1', meal_id: null, plan_date: '2026-09-07', meal_type: 'dinner', created_by: null },
          ],
          error: null,
        };
      }
      if (call.table === 'meals') return { data: [MEAL('meal-1', 'Tacos', [{ name: 'tortillas', qty: '8' }]), MEAL('meal-2', 'Oats')], error: null };
      return { data: null, error: null };
    });
    const res = await getMealPlan(scopeWith(db), '2026-09-07');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dates).toHaveLength(7);
    expect(res.data.slots.map((s) => [s.date, s.mealType, s.name])).toEqual([
      ['2026-09-07', 'dinner', null], ['2026-09-08', 'breakfast', 'Oats'], ['2026-09-08', 'dinner', 'Tacos'],
    ]);
    expect(res.data.slots[2].ingredients).toEqual([{ name: 'tortillas', quantity: '8', unit: null }]);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', plan_date: res.data.dates });
    expect(calls[1].filters).toMatchObject({ family_id: 'fam-1', id: ['meal-1', 'meal-2'] });
  });

  it('rejects an invalid week start without a query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await getMealPlan(scopeWith(db), '2026-13-01')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('createRecipe', () => {
  it('writes the recipe dialect of ingredients with the auth user id', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: { id: 'r1', family_id: 'fam-1', name: 'Pancakes', category: 'breakfast', cuisine: null, servings: 4, prep_time_mins: 5, cook_time_mins: 10, difficulty: 'easy', ingredients: [], instructions: [], notes: null, photo_url: null, tags: [], allergy_flags: ['gluten'], is_favorite: false, is_public: false, rating: null, times_made: 0, last_made_at: null, source_url: null, ai_generated: false, estimated_cost_cents: null, created_by: 'auth-user-1', created_at: '', updated_at: '' }, error: null }
      : { data: null, error: null }));
    const res = await createRecipe(scopeWith(db), {
      name: 'Pancakes', category: 'breakfast', difficulty: 'easy', prepTimeMins: 5, cookTimeMins: 10,
      ingredients: [{ name: 'flour', quantity: '1', unit: 'cup' }], instructions: ['Mix', ' Fry '], allergyFlags: ['gluten'],
    });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('family_recipes');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', name: 'Pancakes', category: 'breakfast', created_by: 'auth-user-1', ai_generated: false,
      ingredients: [{ name: 'flour', quantity: '1', unit: 'cup' }], instructions: ['Mix', 'Fry'],
    });
  });

  it('returns the existing recipe instead of inserting when a run retries', async () => {
    const existing = { id: 'r1', family_id: 'fam-1', name: 'Pancakes', category: 'breakfast', cuisine: null, servings: 4, prep_time_mins: null, cook_time_mins: null, difficulty: 'easy', ingredients: [], instructions: [], notes: null, photo_url: null, tags: [], allergy_flags: [], is_favorite: false, is_public: false, rating: null, times_made: 0, last_made_at: null, source_url: null, ai_generated: false, estimated_cost_cents: null, created_by: 'auth-user-1', created_at: '', updated_at: '' };
    const { db, calls } = makeDb(() => ({ data: existing, error: null }));
    const res = await createRecipe(scopeWith(db, { runId: 'run-1', stepId: 'step-1' }), { name: 'pancakes' });
    expect(res.ok && res.data.id === 'r1').toBe(true);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });
});

describe('foodProfile', () => {
  it('folds allergies, favourites and preference facts per member and for the household', async () => {
    const { db } = makeDb((call) => {
      switch (call.table) {
        case 'family_members':
          return {
            data: [
              { id: 'm1', family_id: 'fam-1', user_id: 'u1', display_name: 'Tom', role: 'parent', birthday: null, is_active: true, color: null, avatar_url: null },
              { id: 'm2', family_id: 'fam-1', user_id: null, display_name: 'Ava', role: 'child', birthday: null, is_active: true, color: null, avatar_url: null },
            ],
            error: null,
          };
        case 'rpc:family_allergies':
          return { data: [{ member_id: 'm2', allergies: 'Peanuts, tree nuts; none' }], error: null };
        case 'family_favorites':
          return { data: [{ member_id: 'm1', kind: 'meal', name: 'Taco night' }, { member_id: null, kind: 'recipe', name: 'Lasagna' }], error: null };
        case 'family_facts':
          return {
            data: [
              { member_id: 'm1', category: 'preference', label: "Doesn't eat", value: 'mushrooms' },
              { member_id: null, category: 'preference', label: 'Diet', value: 'vegetarian on weekdays' },
              { member_id: 'm2', category: 'preference', label: 'Bedtime', value: '8pm' },
            ],
            error: null,
          };
        default:
          return { data: null, error: null };
      }
    });
    const res = await foodProfile(scopeWith(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tom = res.data.members.find((m) => m.name === 'Tom');
    const ava = res.data.members.find((m) => m.name === 'Ava');
    expect(tom).toMatchObject({ allergies: [], dislikes: ['mushrooms'], favorites: ['Taco night'] });
    expect(ava).toMatchObject({ allergies: ['peanuts', 'tree nuts'], dislikes: [], favorites: [] });
    expect(res.data.household).toEqual({
      allergies: ['peanuts', 'tree nuts'], dislikes: ['mushrooms'],
      favorites: ['Taco night', 'Lasagna'], diet: ['vegetarian on weekdays'],
    });
  });

  it('fails closed when any of the reads fails', async () => {
    const { db } = makeDb((call) => (call.table === 'family_facts'
      ? { data: null, error: { code: '42501', message: 'permission denied' } }
      : { data: [], error: null }));
    expect(await foodProfile(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
  });
});
