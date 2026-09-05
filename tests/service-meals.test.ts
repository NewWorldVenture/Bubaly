// Behavioural tests for the meals service against a hand-written Supabase
// fake. The headline is `planWeek`'s rollback: a failed insert must put the
// previous slots back and remove any dish the call created, so a failed
// replan is a no-op rather than an empty week. The rest pins the column
// choices (auth user id in `created_by`), family scoping on every query, the
// per-meal-type slot clearing, and the pure helpers the planner relies on.
import { describe, it, expect } from 'vitest';
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
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
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
      then: (resolve: (value: Reply) => void) => resolve(respond(call, index)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
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
  it('reuses an existing dish case-insensitively instead of inserting', async () => {
    const { db, calls } = makeDb(() => ({ data: MEAL('meal-1', 'Tacos'), error: null }));
    const res = await ensureMealByName(scopeWith(db), { name: 'tacos' });
    expect(res.ok && !res.data.created && res.data.meal.id === 'meal-1').toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters.family_id).toBe('fam-1');
    expect(calls[0].filters['ilike:name']).toBe('tacos');
  });

  it('creates the dish with the auth user id in created_by', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: MEAL('meal-9', 'Ramen'), error: null }
      : { data: null, error: null }));
    const res = await ensureMealByName(scopeWith(db), { name: ' Ramen ', mealType: 'lunch', ingredients: [{ name: 'noodles', quantity: '1', unit: 'pack' }] });
    expect(res.ok && res.data.created).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('meals');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', name: 'Ramen', meal_type: 'lunch', created_by: 'auth-user-1',
      ingredients: [{ name: 'noodles', qty: '1', unit: 'pack' }],
    });
  });
});

describe('planWeek', () => {
  it('rejects bad input before touching the database', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const scope = scopeWith(db);
    expect(await planWeek(scope, [])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await planWeek(scope, [{ date: 'monday', mealName: 'Tacos' }])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await planWeek(scope, [{ date: '2026-09-07' }])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await planWeek(scope, [
      { date: '2026-09-07', mealName: 'Tacos' }, { date: '2026-09-07', mealName: 'Curry' },
    ])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('creates missing dishes, clears only the targeted slots per meal type, and inserts the plan', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'meals' && call.kind === 'select') {
        return { data: call.filters['ilike:name'] === 'Tacos' ? MEAL('meal-1', 'Tacos') : null, error: null };
      }
      if (call.table === 'meals' && call.kind === 'insert') return { data: MEAL('meal-2', 'Curry'), error: null };
      if (call.table === 'meal_plans' && call.kind === 'select') {
        // Only the dinner group holds something today; the lunch group is empty.
        return call.filters.meal_type === 'dinner'
          ? { data: [{ family_id: 'fam-1', meal_id: 'meal-old', plan_date: '2026-09-07', meal_type: 'dinner', created_by: 'auth-user-1' }], error: null }
          : { data: [], error: null };
      }
      if (call.table === 'meal_plans' && call.kind === 'insert') {
        const rows = call.payload as Record<string, unknown>[];
        return { data: rows.map((r, i) => ({ ...r, id: `plan-${i}`, created_at: NOW.toISOString(), updated_at: NOW.toISOString() })), error: null };
      }
      if (call.table === 'agent_activity') return { data: { id: 'activity-1' }, error: null };
      return { data: null, error: null };
    });
    const res = await planWeek(scopeWith(db, { actorKind: 'ai' }), [
      { date: '2026-09-07', mealType: 'dinner', mealName: 'Tacos' },
      { date: '2026-09-09', mealType: 'lunch', mealName: 'Curry' },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planned.map((p) => [p.date, p.mealType, p.name])).toEqual([
      ['2026-09-07', 'dinner', 'Tacos'], ['2026-09-09', 'lunch', 'Curry'],
    ]);
    expect(res.data.createdMeals).toBe(1);
    expect(res.data.replaced).toBe(1);

    const deletes = calls.filter((c) => c.table === 'meal_plans' && c.kind === 'delete');
    expect(deletes).toHaveLength(2);
    // Monday dinner and Wednesday lunch are cleared as two groups; Monday lunch is never touched.
    expect(deletes.map((d) => [d.filters.meal_type, d.filters.plan_date])).toEqual([
      ['dinner', ['2026-09-07']], ['lunch', ['2026-09-09']],
    ]);
    for (const call of calls) expect(call.filters.family_id ?? (call.payload as Record<string, unknown>[])?.[0]?.family_id ?? 'fam-1').toBe('fam-1');

    const insert = calls.find((c) => c.table === 'meal_plans' && c.kind === 'insert');
    expect(insert?.payload).toEqual([
      { family_id: 'fam-1', meal_id: 'meal-1', plan_date: '2026-09-07', meal_type: 'dinner', created_by: 'auth-user-1' },
      { family_id: 'fam-1', meal_id: 'meal-2', plan_date: '2026-09-09', meal_type: 'lunch', created_by: 'auth-user-1' },
    ]);
    const activity = calls.find((c) => c.table === 'agent_activity');
    expect(activity?.kind).toBe('insert');
    expect(activity?.payload).toMatchObject({ agent: 'meal_planner', href: '/dashboard/meals' });
  });

  it('restores the previous slots and removes created dishes when the insert fails', async () => {
    const snapshot = [{ family_id: 'fam-1', meal_id: 'meal-old', plan_date: '2026-09-07', meal_type: 'dinner', created_by: 'auth-user-1' }];
    const { db, calls } = makeDb((call) => {
      if (call.table === 'meals' && call.kind === 'select') return { data: null, error: null };
      if (call.table === 'meals' && call.kind === 'insert') return { data: MEAL('meal-new', 'Curry'), error: null };
      if (call.table === 'meal_plans' && call.kind === 'select') return { data: snapshot, error: null };
      if (call.table === 'meal_plans' && call.kind === 'insert') {
        const rows = call.payload as Record<string, unknown>[];
        // The first insert is the plan (fails); the second is the restore (succeeds).
        if (rows[0]?.meal_id === 'meal-new') return { data: null, error: { code: '23503', message: 'insert or update on table "meal_plans" violates foreign key constraint' } };
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    });
    const res = await planWeek(scopeWith(db), [{ date: '2026-09-07', mealName: 'Curry' }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('db');

    const planWrites = calls.filter((c) => c.table === 'meal_plans' && c.kind !== 'select');
    expect(planWrites.map((c) => c.kind)).toEqual(['delete', 'insert', 'delete', 'insert']);
    expect(planWrites[3].payload).toEqual(snapshot);
    const mealDelete = calls.find((c) => c.table === 'meals' && c.kind === 'delete');
    expect(mealDelete?.filters).toMatchObject({ family_id: 'fam-1', id: ['meal-new'] });
    expect(calls.some((c) => c.table === 'agent_activity')).toBe(false);
  });

  it('removes created dishes and stops when a slot read fails, before anything is cleared', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'meals' && call.kind === 'insert') return { data: MEAL('meal-new', 'Curry'), error: null };
      if (call.table === 'meal_plans' && call.kind === 'select') return { data: null, error: { code: '42501', message: 'permission denied' } };
      return { data: null, error: null };
    });
    const res = await planWeek(scopeWith(db), [{ date: '2026-09-07', mealName: 'Curry' }]);
    expect(res).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((c) => c.table === 'meal_plans' && c.kind === 'delete')).toBe(false);
    expect(calls.find((c) => c.table === 'meals' && c.kind === 'delete')?.filters.id).toEqual(['meal-new']);
  });
});

describe('setSlot', () => {
  it('plans one slot and reports whether it replaced something', async () => {
    const { db } = makeDb((call) => {
      if (call.table === 'meals' && call.kind === 'select') return { data: MEAL('meal-1', 'Tacos'), error: null };
      if (call.table === 'meal_plans' && call.kind === 'select') return { data: [], error: null };
      if (call.table === 'meal_plans' && call.kind === 'insert') {
        const rows = call.payload as Record<string, unknown>[];
        return { data: rows.map((r) => ({ ...r, id: 'plan-1' })), error: null };
      }
      return { data: null, error: null };
    });
    const res = await setSlot(scopeWith(db), { date: '2026-09-07', mealName: 'Tacos' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ id: 'plan-1', date: '2026-09-07', mealType: 'dinner', name: 'Tacos', replaced: false });
  });
});

describe('getMealPlan', () => {
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
        case 'medical_profiles':
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
