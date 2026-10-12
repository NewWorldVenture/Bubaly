import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { parsePantryRecipes } from '@/lib/meals/pantry-chef';
import { addFromMealPlan } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// H15 — Fridge Chef's add-to-grocery and add-to-plan phases inserted raw rows,
// skipping the services' bounds and dedupe. The body bound is 8 MiB (photos),
// and nothing bounded a single name: a plan ingredient over 300 characters —
// model-emitted, or posted by hand — was stored on the dish, and from then on
// addFromMealPlan refused the whole week with "Check the items to add." (the
// meals page button, the groceries.addFromMealPlan tool and the planners'
// grocery step), until the slot was removed. Phase 2 added duplicate lines and
// names of any length.
//
// The route is driven for real against an in-memory database; the grocery
// step afterwards is the real service.

const FAMILY = 'family-one';
const LONG = `Fresh ${'basil, '.repeat(60)}`.trim(); // well over 300 characters

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: h.role, member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => { throw new Error('the photo phase is not under test'); } }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Smart Kitchen gate is covered by tests/fridge-chef-is-a-kitchen-feature.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));

import { POST } from '@/app/api/ai/pantry-chef/route';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T09:00:00Z'));
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { recipe_url: null, image_url: null, meal_type: 'dinner', notes: null },
    meal_plans: { idempotency_key: null },
    grocery_lists: { is_archived: false, archived_at: null },
    grocery_items: { is_checked: false, quantity: null, category: null },
  } });
  h.db = db;
  h.role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const post = (body: unknown) => POST(new NextRequest('https://fixture.invalid/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const scope = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY, userId: 'user-one', memberId: 'member-one',
  role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date(), requestId: 'fixture',
});

describe('a planned Fridge Chef recipe cannot block the week\'s grocery list', () => {
  it('an over-long ingredient is not stored, and "add this week\'s plan to the list" still works', async () => {
    const response = await post({ addToPlan: { title: 'Pesto pasta', have: ['pasta'], need: [LONG, 'parmesan'] } });
    expect(response.status).toBe(200);

    const meal = db.table('meals')[0];
    expect((meal.ingredients as { name: string }[]).map((i) => i.name)).toEqual(['pasta', 'parmesan']);

    const added = await addFromMealPlan(scope(), { from: '2026-09-14', to: '2026-09-14', usePantry: false });
    expect(added.ok, added.ok ? '' : added.error).toBe(true);
    expect(db.table('grocery_items').map((row) => row.name).sort()).toEqual(['parmesan', 'pasta']);
  });

  it('the model\'s own recipes carry no name the services would refuse', () => {
    const [recipe] = parsePantryRecipes(JSON.stringify([{ title: 'Soup', have: ['carrots', LONG], need: [LONG, 'stock'], steps: 'Simmer.', minutes: 30 }]));
    expect(recipe.have).toEqual(['carrots']);
    expect(recipe.need).toEqual(['stock']);
  });
});

describe('Fridge Chef adds to the grocery list through the grocery service', () => {
  it('skips what is already open on the list, files the rest by aisle, and drops over-long names', async () => {
    db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries', created_by: 'user-one' }]);
    db.seed('grocery_items', [{ id: 'milk', family_id: FAMILY, list_id: 'list-1', name: 'Milk', created_by: 'user-one' }]);

    const response = await post({ addToGrocery: ['milk', 'eggs', LONG] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 1, skipped: 1 });
    const names = db.table('grocery_items').map((row) => row.name);
    expect(names).toEqual(['Milk', 'eggs']);
    expect(db.table('grocery_items').find((row) => row.name === 'eggs')?.category).toBeTruthy();
  });

  it('a second tap adds nothing twice', async () => {
    await post({ addToGrocery: ['eggs', 'butter'] });
    await post({ addToGrocery: ['eggs', 'butter'] });
    expect(db.table('grocery_items').map((row) => row.name)).toEqual(['eggs', 'butter']);
  });
});

describe('a guest cannot write the household\'s list or week through Fridge Chef', () => {
  it.each([
    ['addToPlan', { addToPlan: { title: 'Soup', have: ['carrots'], need: [] } }],
    ['addToGrocery', { addToGrocery: ['eggs'] }],
  ])('%s is refused before anything is written', async (_phase, body) => {
    h.role = 'guest';

    const response = await post(body);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'actionRefusal.notAllowed' });
    expect(db.table('meals')).toEqual([]);
    expect(db.table('meal_plans')).toEqual([]);
    expect(db.table('grocery_items')).toEqual([]);
  });
});
