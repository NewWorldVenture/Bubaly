// Bubaly's meal-planning tools (`meals.setSlot`, which also answers the chat's
// and Magic Import's `create_meal_plan_entry`, and `meals.planWeek`) handed the
// meals service `ingredients: []` whenever the model sent none. The service
// reads an explicit list as "this exact variant of the dish", and reads an
// absent one as "whichever dish has that name". So:
//
//   - a slot naming an existing dish by `meal_id` was refused outright
//     ("Choose one meal, recipe or custom dish…"), because a meal id with an
//     ingredient list is a contradiction — the assistant could never plan a
//     saved meal, and one such entry failed a whole week's plan;
//   - "plan tacos on Tuesday" did not match the family's Tacos (which HAS
//     ingredients), so a second, empty Tacos went into the library and onto
//     the plan, and "add this week's plan to the list" then had nothing to add.
//
// The planner route (`app/api/ai/meals/plan/route.ts`) already passes
// ingredients only when the model wrote some; the tools now do the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { mealTools } from '@/lib/ai/tools/meals';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';
const NOW = new Date('2026-09-05T12:00:00Z');
let db: InMemorySupabase & SupabaseClient<Database>;

const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
  actorKind: 'ai', tz: 'America/New_York', now: NOW,
});

const dish = (id: string, name: string, ingredients: unknown[]) => ({
  id, family_id: FAMILY, name, meal_type: 'dinner', recipe_url: null, image_url: null,
  ingredients, notes: null, created_by: 'auth-user-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
});

async function run(name: string, args: Record<string, unknown>) {
  const tool = mealTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(scope(), tool.input.parse(args));
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { ingredients: [], recipe_url: null, image_url: null, meal_type: 'dinner' },
    meal_plans: { meal_id: null, idempotency_key: null },
  } });
  db.seed('meals', [dish('tacos', 'Tacos', [{ name: 'tortillas', qty: '8', unit: null }, { name: 'beans', qty: '1', unit: 'can' }])]);
  db.replace('meal_plans', []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('meals.setSlot', () => {
  it('plans a saved meal named by its id', async () => {
    const res = await run('meals.setSlot', { date: '2026-09-08', meal_type: 'dinner', meal_id: 'tacos' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ family_id: FAMILY, meal_id: 'tacos', plan_date: '2026-09-08', meal_type: 'dinner' })]);
    expect(db.table('meals')).toHaveLength(1);
  });

  it('plans a saved meal by id with its stored ingredients, whatever list the model added', async () => {
    const res = await run('meals.setSlot', { date: '2026-09-08', meal_id: 'tacos', ingredients: [{ name: 'cheese' }] });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'tacos' })]);
    expect(db.table('meals')).toEqual([expect.objectContaining({ id: 'tacos', ingredients: [{ name: 'tortillas', qty: '8', unit: null }, { name: 'beans', qty: '1', unit: 'can' }] })]);
  });

  it('reads an empty list from the model as no list', async () => {
    const res = await run('meals.setSlot', { date: '2026-09-08', meal_name: 'Tacos', ingredients: [] });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(db.table('meals')).toHaveLength(1);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'tacos' })]);
  });

  it('plans the family\'s own dish by name, ingredients and all, instead of an empty copy', async () => {
    // The legacy shape the chat and Magic Import send.
    const res = await run('meals.setSlot', { meal_name: 'tacos', plan_date: '2026-09-08' });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(db.table('meals')).toHaveLength(1);
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ meal_id: 'tacos', plan_date: '2026-09-08' })]);
  });

  it('still saves a new dish with the ingredients the model wrote', async () => {
    const res = await run('meals.setSlot', {
      date: '2026-09-09', meal_name: 'Curry', ingredients: [{ name: 'rice', quantity: '1', unit: 'cup' }],
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    const curry = db.table('meals').find((row) => row.name === 'Curry');
    expect(curry).toMatchObject({ ingredients: [{ name: 'rice', qty: '1', unit: 'cup' }] });
  });
});

describe('meals.planWeek', () => {
  it('plans a week mixing a saved meal by id and a known dish by name, with no duplicates', async () => {
    const res = await run('meals.planWeek', { entries: [
      { date: '2026-09-07', meal_type: 'dinner', meal_id: 'tacos' },
      { date: '2026-09-10', meal_type: 'dinner', meal_name: 'Tacos' },
      { date: '2026-09-11', meal_type: 'dinner', meal_name: 'Curry', ingredients: [{ name: 'rice' }] },
    ] });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(db.table('meals').map((row) => row.name).sort()).toEqual(['Curry', 'Tacos']);
    const planned = db.table('meal_plans').map((row) => `${row.plan_date}:${row.meal_id}`);
    expect(planned).toEqual(expect.arrayContaining(['2026-09-07:tacos', '2026-09-10:tacos']));
    expect(planned).toHaveLength(3);
  });
});
