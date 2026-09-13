// The meal planner writes through the service.
//
// The sharpest case: dropping a meal into a slot used to be a raw INSERT, so
// planning Tuesday dinner twice left two dinners on one Tuesday with nothing to
// say which the family meant. `setSlot` replaces what is in the slot.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { createMealAction, planMealAction, removeMealPlanAction } from '@/app/(app)/dashboard/meals/actions';

const FAMILY = 'family-1';
const OTHER = 'family-2';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const plans = (familyId = FAMILY) => db.table('meal_plans').filter((r) => r.family_id === familyId);

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { meal_plans: { meal_id: null, idempotency_key: null }, meals: { description: null, ingredients: [], image_url: null, recipe_url: null } },
  });
  db.seed('meals', [
    { id: 'tacos', family_id: FAMILY, name: 'Tacos' },
    { id: 'curry', family_id: FAMILY, name: 'Curry' },
  ]);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: FAMILY, role: 'parent',
      family: { name: 'Family One', timezone: 'America/New_York' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('planning a meal into a slot', () => {
  it('lands in the slot', async () => {
    const result = await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(plans()).toHaveLength(1);
    expect(plans()[0]!.meal_id).toBe('tacos');
  });

  it('REPLACES what is already there rather than stacking a second dinner', async () => {
    await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    await planMealAction({ mealId: 'curry', date: '2026-09-08', mealType: 'dinner' });

    // The raw insert left both, and the week showed two dinners on one Tuesday.
    expect(plans()).toHaveLength(1);
    expect(plans()[0]!.meal_id).toBe('curry');
  });

  it('leaves a different meal type on the same day alone', async () => {
    await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    await planMealAction({ mealId: 'curry', date: '2026-09-08', mealType: 'lunch' });
    expect(plans()).toHaveLength(2);
  });

  it('takes family_id from the session', async () => {
    await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    expect(plans()[0]!.family_id).toBe(FAMILY);
  });

  it('refuses a slot with no meal or no day', async () => {
    expect((await planMealAction({ mealId: '', date: '2026-09-08', mealType: 'dinner' })).ok).toBe(false);
    expect((await planMealAction({ mealId: 'tacos', date: '', mealType: 'dinner' })).ok).toBe(false);
    expect(plans()).toHaveLength(0);
  });

  it('converts a saved family recipe preserving fractional ingredients and links despite a same-name dish', async () => {
    db.seed('family_recipes', [{ id: 'recipe-tacos', family_id: FAMILY, name: 'Tacos',
      ingredients: [{ name: 'beans', quantity: '1 1/2', unit: 'cups' }, { name: 'salt', quantity: 'to taste', unit: null }],
      source_url: 'https://example.com/tacos', photo_url: 'https://example.com/tacos.jpg',
    }]);
    const result = await planMealAction({ recipeId: 'recipe-tacos', date: '2026-09-08', mealType: 'dinner' });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.slot).toMatchObject({ id: result.id, date: '2026-09-08', name: 'Tacos', ingredients: [
      { name: 'beans', quantity: '1 1/2', unit: 'cups' }, { name: 'salt', quantity: 'to taste', unit: null },
    ] });
    expect(result.slot.mealId).not.toBe('tacos');
    expect(db.table('meals').find((meal) => meal.id === result.slot.mealId)).toMatchObject({
      recipe_url: 'https://example.com/tacos', image_url: 'https://example.com/tacos.jpg',
      ingredients: [{ name: 'beans', qty: '1 1/2', unit: 'cups' }, { name: 'salt', qty: 'to taste', unit: null }],
    });
    expect(db.table('meals').find((meal) => meal.id === 'tacos')?.ingredients).toEqual([]);
  });

  it('saves a custom dish into its slot and retains ingredient strings through readback', async () => {
    const result = await planMealAction({ mealName: 'Pasta', date: '2026-09-08', mealType: 'dinner',
      ingredients: [{ name: 'tomatoes', quantity: '2–3', unit: null }, { name: 'basil', quantity: null, unit: 'handful' }],
    });
    expect(result).toMatchObject({ ok: true, slot: { name: 'Pasta', ingredients: [
      { name: 'tomatoes', quantity: '2–3', unit: null }, { name: 'basil', quantity: null, unit: 'handful' },
    ] } });
  });

  it('creates a library-only custom meal without planning it', async () => {
    const result = await createMealAction({ name: 'Breakfast oats', mealType: 'breakfast',
      ingredients: [{ name: 'oats', quantity: '1/2', unit: 'cup' }], imageUrl: 'https://example.com/oats.jpg',
    });
    expect(result).toMatchObject({ ok: true, meal: { family_id: FAMILY, name: 'Breakfast oats',
      ingredients: [{ name: 'oats', qty: '1/2', unit: 'cup' }], image_url: 'https://example.com/oats.jpg',
    } });
    expect(plans()).toHaveLength(0);
  });

  it('refuses foreign meals and recipes without changing the existing slot', async () => {
    await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    db.seed('meals', [{ id: 'foreign-meal', name: 'Secret', family_id: OTHER }]);
    db.seed('family_recipes', [{ id: 'foreign-recipe', name: 'Secret', family_id: OTHER, ingredients: [] }]);
    for (const source of [{ mealId: 'foreign-meal' }, { recipeId: 'foreign-recipe' }]) {
      expect((await planMealAction({ ...source, date: '2026-09-08', mealType: 'dinner' })).ok).toBe(false);
    }
    expect(plans()).toEqual([expect.objectContaining({ meal_id: 'tacos' })]);
  });
});

describe('clearing a planned meal', () => {
  it('clears the family’s own', async () => {
    const created = await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await removeMealPlanAction(created.id)).ok).toBe(true);
    expect(plans()).toHaveLength(0);
  });

  it('cannot clear another household’s — the client filtered id alone', async () => {
    db.seed('meal_plans', [{ id: 'theirs', family_id: OTHER, meal_id: 'x', plan_date: '2026-09-08', meal_type: 'dinner' }]);
    const result = await removeMealPlanAction('theirs');
    expect(result.ok).toBe(false);
    expect(plans(OTHER)).toHaveLength(1);
  });

  it('refuses an empty id rather than issuing an unfiltered delete', async () => {
    await planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' });
    expect((await removeMealPlanAction('')).ok).toBe(false);
    expect(plans()).toHaveLength(1);
  });
});

describe('a caller who is not signed in', () => {
  it.each([
    ['plan', () => planMealAction({ mealId: 'tacos', date: '2026-09-08', mealType: 'dinner' })],
    ['remove', () => removeMealPlanAction('some-id')],
    ['create', () => createMealAction({ name: 'Tacos' })],
  ])('is redirected on %s, not handed an error toast', async (_n, call) => {
    mocks.requireUserContext.mockRejectedValueOnce(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    );
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
  });
});
