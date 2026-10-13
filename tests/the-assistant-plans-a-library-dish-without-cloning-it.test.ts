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
import { parseStepInput } from '@/lib/ai/planner/schema';
import { instantiateTemplate, templateContextFrom, templateFor } from '@/lib/ai/planner/templates/index';
import { getTool } from '@/lib/ai/tools/registry';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import { addFromMealPlan } from '@/lib/services/groceries';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

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

// A meal_id said WITH a different name, or with ingredients of its own, is two
// dishes in one call. The adapter planned the id and dropped the rest without a
// word, so "meal-1, Curry" put the family's Tacos over Tuesday's Curry; the
// service refuses the same contradiction from any other caller. It is refused
// here too, before anything is written. The id's own name, however it is
// spelled, and an empty ingredients list still say one dish.
describe('a dish chosen by id and contradicted by name or ingredients is refused', () => {
  const REFUSED = { ok: false, code: 'invalid_input', error: 'Choose one meal, recipe or custom dish with valid ingredients.' };

  /** The household, plus a Curry already planned for Tuesday that a wrong call would overwrite. */
  function plannedHousehold() {
    const { db, scope } = household();
    db.seed('meals', [
      { id: 'meal-2', family_id: FAMILY, name: 'Curry', meal_type: 'dinner', created_by: 'auth-user-1', ingredients: [{ name: 'rice', qty: '1', unit: 'cup' }] },
      { id: 'meal-x', family_id: 'fam-2', name: 'Pizza', meal_type: 'dinner', created_by: 'auth-user-2', ingredients: [{ name: 'dough', qty: null, unit: null }] },
    ]);
    db.seed('meal_plans', [{ id: 'plan-tue', family_id: FAMILY, meal_id: 'meal-2', plan_date: '2026-09-08', meal_type: 'dinner', created_by: 'auth-user-1' }]);
    const tables = () => structuredClone({ meals: db.table('meals'), meal_plans: db.table('meal_plans'), agent_activity: db.table('agent_activity') });
    return { db, scope, before: tables(), tables };
  }

  const BEANS = [{ name: 'beans', quantity: '2', unit: 'cans' }];

  it.each([
    ['meals.setSlot, a different meal_name', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Curry' }],
    ['meals.setSlot, a different name', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1', name: 'curry' }],
    ['create_meal_plan_entry, a different meal_name', 'create_meal_plan_entry', { plan_date: '2026-09-08', meal_type: 'dinner', meal_id: 'meal-1', meal_name: 'Curry' }],
    ['meals.planWeek, a different meal_name', 'meals.planWeek', { entries: [{ date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Curry' }] }],
    ['meals.setSlot, ingredients', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1', ingredients: BEANS }],
    ['meals.setSlot, its own name AND ingredients', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Tacos', ingredients: BEANS }],
    ['create_meal_plan_entry, ingredients', 'create_meal_plan_entry', { plan_date: '2026-09-08', meal_id: 'meal-1', ingredients: BEANS }],
    ['meals.planWeek, ingredients', 'meals.planWeek', { entries: [{ date: '2026-09-08', meal_id: 'meal-1', ingredients: BEANS }] }],
    ['meals.planWeek, after a new dish earlier in the week', 'meals.planWeek', { entries: [
      { date: '2026-09-07', meal_name: 'Chili', ingredients: BEANS },
      { date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Curry' },
    ] }],
  ])('%s: refused, and Tuesday keeps its Curry', async (_label, name, input) => {
    const { scope, before, tables } = plannedHousehold();

    const res = await run(name, scope, input);

    expect(res).toEqual(REFUSED);
    expect(tables()).toEqual(before);
  });

  it('a name it cannot check against the library is refused, not planned', async () => {
    const { db, scope, before, tables } = plannedHousehold();
    const faulty = { ...scope, db: withFaults(db, (table, calls) => (
      table === 'meals' && calls.some((call) => call.method === 'select' && call.args[0] === 'id, name')
        ? { code: 'XX000', message: 'column meals.secret_flag is corrupt' } : null)) };

    const res = await run('meals.setSlot', faulty, { date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Curry' });

    expect(res).toEqual({ ok: false, code: 'db', error: 'Could not read that meal.' });
    expect(tables()).toEqual(before);
  });

  it.each([
    ['meals.setSlot, meal_id alone', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1' }],
    ['meals.setSlot, its own name in another case and spacing', 'meals.setSlot', { date: '2026-09-08', meal_id: 'meal-1', meal_name: '  tACOS ', ingredients: [] }],
    ['create_meal_plan_entry, its own name', 'create_meal_plan_entry', { plan_date: '2026-09-08', meal_type: 'dinner', meal_id: 'meal-1', meal_name: 'Tacos' }],
    ['meals.setSlot, the name alone', 'meals.setSlot', { date: '2026-09-08', meal_name: 'Tacos' }],
    ['meals.planWeek, its own name and null ingredients', 'meals.planWeek', { entries: [{ date: '2026-09-08', meal_id: 'meal-1', meal_name: 'tacos', ingredients: null }] }],
    ['meals.planWeek, the name alone', 'meals.planWeek', { entries: [{ date: '2026-09-08', meal_name: 'Tacos' }] }],
  ])('%s: one dish, planned', async (_label, name, input) => {
    const { db, scope, before } = plannedHousehold();

    const res = await run(name, scope, input);

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true });
    expect(db.table('meals')).toEqual(before.meals);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'meal-1', plan_date: '2026-09-08', meal_type: 'dinner' })]);
  });

  // The chief-of-staff skeleton's dinner step, as the model fills it: the
  // skeleton's own empty meal_name is no name at all; the model's is.
  function dinnerStep() {
    const ctx = templateContextFrom({
      tz: 'America/New_York', nowIso: '2026-09-05T16:00:00Z', todayKey: '2026-09-05', requestText: 'Sort out the week',
      viewerMemberId: 'member-1', managerIds: ['member-1'],
    });
    const step = instantiateTemplate(templateFor('chief_of_staff')!, ctx).steps.find((s) => s.key === 'meal_act');
    const skeleton = parseStepInput(step?.input);
    if (!step?.tool_name || !skeleton.ok) throw new Error('the chief-of-staff template has no dinner step');
    return { tool: step.tool_name, skeleton: skeleton.value };
  }

  it('the chief-of-staff dinner step, filled with an id and another dish\'s name, is refused', async () => {
    const { scope, before, tables } = plannedHousehold();
    const { tool, skeleton } = dinnerStep();

    const res = await run(tool, scope, { ...skeleton, date: '2026-09-08', meal_id: 'meal-1', meal_name: 'Curry' });

    expect(res).toEqual(REFUSED);
    expect(tables()).toEqual(before);
  });

  it('the chief-of-staff dinner step, filled with an id alone, plans it', async () => {
    const { db, scope } = plannedHousehold();
    const { tool, skeleton } = dinnerStep();

    const res = await run(tool, scope, { ...skeleton, date: '2026-09-08', meal_id: 'meal-1' });

    expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true, data: { meal_id: 'meal-1', name: 'Tacos' } });
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'meal-1', plan_date: '2026-09-08', meal_type: 'dinner' })]);
  });

  it('another family\'s meal id is not found, whatever name comes with it', async () => {
    const { scope, before, tables } = plannedHousehold();

    const res = await run('meals.setSlot', scope, { date: '2026-09-08', meal_id: 'meal-x', meal_name: 'Curry' });

    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(tables()).toEqual(before);
  });
});
