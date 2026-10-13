// The assistant's meal tools plan the family's own dish, by name or by id.
//
// meals.setSlot (and its legacy names, create_meal_plan_entry included) and
// meals.planWeek handed the meal service `ingredients: []` whenever the model
// named no ingredients. The service reuses a library dish only when every
// field it is given matches, so "plan tacos for Tuesday" did not match the
// family's Tacos (with tortillas): it inserted a second, EMPTY "Tacos", planned
// that, and "add this week to the shopping list" then refused the whole week
// with "Add ingredients to Tacos". And a `meal_id` entry always carried that
// `ingredients` key, which the service refuses for a saved meal — so the
// documented "existing meal id" path never worked at all.
//
// Driven through the real registry tools, parsed by their own schemas, against
// the in-memory database; the shopping list afterwards is the real service.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool } from '@/lib/ai/tools/registry';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import { addFromMealPlan } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';

function household() {
  const db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { recipe_url: null, image_url: null, notes: null, meal_type: 'dinner' },
    meal_plans: { idempotency_key: null },
    grocery_lists: { is_archived: false, archived_at: null },
    grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
  } });
  db.seed('meals', [{
    id: 'meal-1', family_id: FAMILY, name: 'Tacos', meal_type: 'dinner', created_by: 'auth-user-1',
    ingredients: [{ name: 'tortillas', qty: '8', unit: null }], created_at: '2026-01-01T00:00:00Z',
  }]);
  db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries', created_by: 'auth-user-1' }]);
  const scope: ServiceScope = {
    db, familyId: FAMILY, userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: 'America/New_York', now: new Date('2026-09-05T12:00:00Z'),
  };
  return { db, scope };
}

async function run(name: string, scope: ServiceScope, raw: unknown) {
  const tool = getTool(name) as ToolDefinition;
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid input for ${name}: ${parsed.error.message}`);
  return tool.execute(scope, parsed.data);
}

describe('a dish named from the library is the library dish', () => {
  it.each([
    ['create_meal_plan_entry', { meal_name: 'Tacos', plan_date: '2026-09-08', meal_type: 'dinner' }],
    ['meals.setSlot', { meal_name: 'tacos', date: '2026-09-08', ingredients: null }],
  ])('%s plans the family\'s Tacos rather than an empty copy of it', async (name, input) => {
    const { db, scope } = household();

    const res = await run(name, scope, input);

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true });
    expect(db.table('meals').map((meal) => meal.id)).toEqual(['meal-1']);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'meal-1', plan_date: '2026-09-08', meal_type: 'dinner' })]);

    // And the week still builds a shopping list.
    const list = await addFromMealPlan(scope, { from: '2026-09-08', to: '2026-09-08', usePantry: false });
    expect(list.ok, list.ok ? '' : list.error).toBe(true);
    expect(db.table('grocery_items').map((item) => item.name)).toEqual(['tortillas']);
  });

  it('meals.planWeek reuses it for every name-only entry', async () => {
    const { db, scope } = household();

    const res = await run('meals.planWeek', scope, { entries: [
      { date: '2026-09-08', meal_name: 'Tacos' },
      { date: '2026-09-10', meal_name: 'Tacos', ingredients: [] },
    ] });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true, data: { created_meals: 0 } });
    expect(db.table('meals')).toHaveLength(1);
    expect(db.table('meal_plans').map((row) => row.meal_id)).toEqual(['meal-1', 'meal-1']);
  });

  it('a new dish the model describes is still created with its ingredients', async () => {
    const { db, scope } = household();

    const res = await run('meals.setSlot', scope, {
      date: '2026-09-09', meal_name: 'Chili', ingredients: [{ name: 'beans', quantity: '2', unit: 'cans' }],
    });

    expect(res.ok).toBe(true);
    const chili = db.table('meals').find((meal) => meal.name === 'Chili');
    expect(chili?.ingredients).toEqual([{ name: 'beans', qty: '2', unit: 'cans' }]);
  });
});

// AUD-1041-SLOT-RESTORE (3). A dish named alone was matched only against
// dishes saved under the meal it was being planned for, so "plan lentil soup
// for dinner" missed the family's Lentil soup saved as a lunch and inserted an
// EMPTY dinner "Lentil soup" — which the shopping list then refused.
describe('a dish named alone is the family\'s dish, whichever meal it was saved under', () => {
  const soup = (id: string, mealType: string, createdAt: string) => ({
    id, family_id: FAMILY, name: 'Lentil soup', meal_type: mealType, created_by: 'auth-user-1',
    ingredients: [{ name: 'lentils', qty: '1', unit: 'cup' }], created_at: createdAt,
  });

  it.each([
    ['meals.setSlot', { meal_name: 'lentil soup', date: '2026-09-08', meal_type: 'dinner' }],
    ['create_meal_plan_entry', { meal_name: 'Lentil soup', plan_date: '2026-09-08' }],
    ['meals.planWeek', { entries: [{ date: '2026-09-08', meal_type: 'dinner', meal_name: 'Lentil soup', ingredients: [] }] }],
  ])('%s plans the lunch-saved Lentil soup for dinner rather than an empty dinner copy', async (name, input) => {
    const { db, scope } = household();
    db.seed('meals', [soup('soup-lunch', 'lunch', '2026-01-02T00:00:00Z')]);

    const res = await run(name, scope, input);

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true });
    expect(db.table('meals').map((meal) => meal.id)).toEqual(['meal-1', 'soup-lunch']);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'soup-lunch', plan_date: '2026-09-08', meal_type: 'dinner' })]);
    const list = await addFromMealPlan(scope, { from: '2026-09-08', to: '2026-09-08', usePantry: false });
    expect(list.ok, list.ok ? '' : list.error).toBe(true);
    expect(db.table('grocery_items').map((item) => item.name)).toEqual(['lentils']);
  });

  it('control: of several saved under that name, the one saved for the planned meal is used', async () => {
    const { db, scope } = household();
    db.seed('meals', [soup('soup-lunch', 'lunch', '2026-01-02T00:00:00Z'), soup('soup-dinner', 'dinner', '2026-01-03T00:00:00Z')]);

    const res = await run('meals.planWeek', scope, { entries: [
      { date: '2026-09-08', meal_type: 'dinner', meal_name: 'Lentil soup' },
      { date: '2026-09-09', meal_type: 'lunch', meal_name: 'Lentil soup' },
    ] });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true, data: { created_meals: 0 } });
    expect(db.table('meal_plans').map((row) => [row.meal_type, row.meal_id])).toEqual([['dinner', 'soup-dinner'], ['lunch', 'soup-lunch']]);
    expect(db.table('meals')).toHaveLength(3);
  });

  it('several saved under that name, none for the planned meal: refused, nothing copied or planned', async () => {
    const { db, scope } = household();
    db.seed('meals', [soup('soup-lunch', 'lunch', '2026-01-02T00:00:00Z'), soup('soup-snack', 'snack', '2026-01-03T00:00:00Z')]);

    const res = await run('meals.setSlot', scope, { meal_name: 'Lentil soup', date: '2026-09-08', meal_type: 'dinner' });

    expect(res).toMatchObject({ ok: false, code: 'invalid_input', error: 'Choose an existing meal with that name from the library.' });
    expect(db.table('meals').map((meal) => meal.id)).toEqual(['meal-1', 'soup-lunch', 'soup-snack']);
    expect(db.table('meal_plans')).toEqual([]);
  });

  it('control: a name the library does not have is still added and planned', async () => {
    const { db, scope } = household();
    db.seed('meals', [soup('soup-lunch', 'lunch', '2026-01-02T00:00:00Z')]);

    const res = await run('meals.setSlot', scope, { meal_name: 'Shakshuka', date: '2026-09-08', meal_type: 'dinner' });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true, data: { name: 'Shakshuka' } });
    const shakshuka = db.table('meals').find((meal) => meal.name === 'Shakshuka');
    expect(shakshuka).toMatchObject({ meal_type: 'dinner', ingredients: [] });
    expect(db.table('meals')).toHaveLength(3);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: shakshuka?.id, meal_type: 'dinner' })]);
  });
});

describe('a dish chosen by its id is planned', () => {
  it('meals.setSlot with meal_id', async () => {
    const { db, scope } = household();

    const res = await run('meals.setSlot', scope, { date: '2026-09-08', meal_id: 'meal-1' });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true, data: { meal_id: 'meal-1', name: 'Tacos' } });
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'meal-1', plan_date: '2026-09-08' })]);
  });

  it('meals.planWeek with meal_id entries, the model\'s null ingredients included', async () => {
    const { db, scope } = household();

    const res = await run('meals.planWeek', scope, { entries: [
      { date: '2026-09-08', meal_id: 'meal-1' },
      { date: '2026-09-09', meal_id: 'meal-1', ingredients: null },
    ] });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true });
    expect(db.table('meal_plans').map((row) => [row.plan_date, row.meal_id])).toEqual([['2026-09-08', 'meal-1'], ['2026-09-09', 'meal-1']]);
    expect(db.table('meals')).toHaveLength(1);
  });
});
