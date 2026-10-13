// Fridge Chef's "Plan for dinner" puts ONE dinner on tonight.
//
// Phase 3 of /api/ai/pantry-chef inserted a new `meals` row and then a raw
// `meal_plans` dinner row. Nothing replaced what tonight already held and no
// unique (family, date, type) key stops a second row, so a family with dinner
// planned — or one that tapped "Plan for dinner" on two cards from one scan —
// got two dinners in one slot, the route said `planned: true`, and the meals
// page's week read refused that week on every load ("We couldn't load all meal
// choices"), Retry included. When the plan insert failed, the dish stayed in
// the library, and each retry added another copy.
//
// The route is driven for real against an in-memory database, and the week is
// read back with the meals page's own reader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { readMealWeek } from '@/lib/meals/collection-reads';
import { mealWeekDays } from '@/lib/meals/week';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const TODAY = '2026-09-14';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => { throw new Error('the photo phase is not under test'); } }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Smart Kitchen gate is covered by tests/fridge-chef-is-a-kitchen-feature.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));

import { POST } from '@/app/api/ai/pantry-chef/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let fault: (table: string, calls: FaultCall[]) => { message: string } | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T18:00:00Z`));
  base = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { recipe_url: null, image_url: null, meal_type: 'dinner', notes: null, ingredients: [] },
    meal_plans: { idempotency_key: null },
  } });
  fault = () => null;
  h.db = withFaults(base, (table, calls) => fault(table, calls));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const plan = (title: string, steps = 'Simmer everything.') => POST(new NextRequest('https://fixture.invalid/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ addToPlan: { title, steps, have: ['carrots'], need: ['stock'] } }),
}));
const tonight = () => base.table('meal_plans').filter((row) => row.plan_date === TODAY && row.meal_type === 'dinner');
const week = () => readMealWeek(base as unknown as SupabaseClient<Database>, FAMILY, mealWeekDays('2026-09-14'));

describe('Plan for dinner replaces tonight\'s dinner', () => {
  it('a dinner already planned is replaced, not joined, and the meals page still reads the week', async () => {
    base.seed('meals', [{ id: 'tacos', family_id: FAMILY, name: 'Tacos', ingredients: [{ name: 'tortillas', qty: null, unit: null }] }]);
    base.seed('meal_plans', [{ id: 'planned', family_id: FAMILY, meal_id: 'tacos', plan_date: TODAY, meal_type: 'dinner', created_by: 'user-one' }]);

    const response = await plan('Vegetable soup');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ planned: true, planDate: TODAY, replaced: true });
    expect(tonight()).toHaveLength(1);
    const soup = base.table('meals').find((meal) => meal.name === 'Vegetable soup');
    expect(tonight()[0].meal_id).toBe(soup?.id);
    // The recipe's method rides along on the dish, as it always did.
    expect(soup?.notes).toBe('Simmer everything.');

    const read = await week();
    expect(read.error).toBeNull();
    expect(read.data?.map((row) => row.meal?.name)).toEqual(['Vegetable soup']);
  });

  it('two cards planned from one scan leave one dinner, the second', async () => {
    expect((await plan('Vegetable soup')).status).toBe(200);
    const second = await plan('Carrot curry');

    expect(await second.json()).toMatchObject({ planned: true, replaced: true });
    expect(tonight()).toHaveLength(1);
    expect(base.table('meals').find((meal) => meal.id === tonight()[0].meal_id)?.name).toBe('Carrot curry');
    expect((await week()).error).toBeNull();
  });

  it('a plan write that fails leaves no dish behind, so retries do not pile up copies', async () => {
    fault = (table, calls) => (table === 'meal_plans' && calls.some((call) => call.method === 'insert') ? { message: 'Fixture insert refused' } : null);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await plan('Vegetable soup');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'pantryChef.couldNotAddThatRecipe' });
    }

    expect(base.table('meals')).toEqual([]);
    expect(base.table('meal_plans')).toEqual([]);
  });

  it('planning the same recipe again reuses its dish rather than cloning it', async () => {
    await plan('Vegetable soup');
    await plan('Vegetable soup');

    expect(base.table('meals').filter((meal) => meal.name === 'Vegetable soup')).toHaveLength(1);
    expect(tonight()).toHaveLength(1);
  });
});
