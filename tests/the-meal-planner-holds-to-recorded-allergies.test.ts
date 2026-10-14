// The one-click AI Meal Planner writes a week the household can eat.
//
// S4 — Auto-plan always sends `write: true`, and its only constraint was the
//   optional free-text "dietary" box, which starts empty. Allergies recorded on
//   a medical profile were never read, the prompt carried no constraint line at
//   all, and nothing checked the model's answer: saved dishes, recipes and new
//   dishes with model-written ingredients all went into meal_plans.
// S5 — pantry items already past their date were offered as "use up these
//   expiring pantry items", sorted first, and the dishes built on them saved.
//
// Driven through the real route against an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: {
    familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC' },
  } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: mocks.complete }),
  describeAIError: () => ({ message: 'Generation unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Free plan's AI allowance (N18) has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
// The plan gate is covered by tests/the-meal-and-recipe-model-endpoints-refuse-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_scope: unknown, _feature: unknown, run: (observer: { used: () => void }) => Promise<string>) => run({ used: vi.fn() }),
}));

import { POST } from '@/app/api/ai/meals/plan/route';

const FAMILY = 'family-one';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const rpc: Record<string, (args: Record<string, unknown>) => unknown> = {};
const request = (overrides: Record<string, unknown> = {}) => new Request('https://fixture.invalid/api/ai/meals/plan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  // Exactly what AutoPlanModal sends when the dietary box is left empty.
  body: JSON.stringify({ weekStart: '2026-09-14', mealTypes: ['dinner'], dietary: [], notes: '', useExpiring: true, avoidRepeats: true, write: true, ...overrides }),
});
const prompt = () => String(mocks.complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
/** The fenced block that follows a heading in the prompt, or '' when the heading is absent. */
const section = (heading: string) => {
  const at = prompt().indexOf(heading);
  if (at < 0) return '';
  const rest = prompt().slice(at);
  return rest.slice(0, rest.indexOf('<<<END_') < 0 ? undefined : rest.indexOf('<<<END_'));
};
const answer = (assignments: Record<string, unknown>[]) => mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments }) });
const plannedNames = () => db.table('meal_plans').map((row) => db.table('meals').find((meal) => meal.id === row.meal_id)?.name).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-12T15:00:00Z'));
  for (const key of Object.keys(rpc)) delete rpc[key];
  db = createInMemorySupabase<SupabaseClient<Database>>({ rpc: rpc as never, defaults: {
    meals: { ingredients: [], recipe_url: null, image_url: null, notes: null, meal_type: 'dinner' },
    meal_plans: { idempotency_key: null },
  } });
  mocks.db = db;
  mocks.complete.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Dana', role: 'parent', is_active: true, user_id: 'user-one', created_at: '2026-01-01T00:00:00Z' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('S4: recorded allergies reach the planner and hold its answer to them', () => {
  beforeEach(() => {
    db.seed('medical_profiles', [{ id: 'mp-1', family_id: FAMILY, member_id: 'member-one', allergies: 'Peanuts' }]);
    db.seed('meals', [
      { id: 'pad-thai', family_id: FAMILY, name: 'Pad thai', ingredients: [{ name: 'rice noodles', qty: null, unit: null }, { name: 'crushed peanuts', qty: null, unit: null }] },
      { id: 'tacos', family_id: FAMILY, name: 'Tacos', ingredients: [{ name: 'tortillas', qty: null, unit: null }] },
    ]);
    db.seed('family_recipes', [{ id: 'satay', family_id: FAMILY, name: 'Chicken satay', category: 'dinner', allergy_flags: [],
      ingredients: [{ name: 'chicken', quantity: '1', unit: 'lb' }, { name: 'peanut butter', quantity: '2', unit: 'tbsp' }] }]);
  });

  it('puts the allergy in the prompt when the dietary box was left empty, and does not offer the dishes that carry it', async () => {
    answer([{ date: '2026-09-14', meal_type: 'dinner', ref: 'meal:tacos', name: 'Tacos' }]);

    expect((await POST(request())).status).toBe(200);

    expect(section('Dietary constraints (strict):')).toContain('allergy: peanuts');
    expect(prompt()).toContain('meal:tacos');
    expect(prompt()).not.toContain('meal:pad-thai');
    expect(prompt()).not.toContain('recipe:satay');
  });

  it('writes only the dishes that clear the allergy, whatever the model chose', async () => {
    answer([
      { date: '2026-09-14', meal_type: 'dinner', ref: 'meal:pad-thai', name: 'Pad thai' },
      { date: '2026-09-15', meal_type: 'dinner', ref: 'recipe:satay', name: 'Chicken satay' },
      { date: '2026-09-16', meal_type: 'dinner', ref: 'new', name: 'Peanut noodles', ingredients: [{ name: 'noodles' }] },
      { date: '2026-09-17', meal_type: 'dinner', ref: 'new', name: 'Thai curry', ingredients: [{ name: 'coconut milk' }, { name: 'peanuts', quantity: '1', unit: 'cup' }] },
      { date: '2026-09-18', meal_type: 'dinner', ref: 'new', name: 'Garden pasta', ingredients: [{ name: 'pasta' }, { name: 'tomatoes' }] },
      { date: '2026-09-19', meal_type: 'dinner', ref: 'meal:tacos', name: 'Tacos' },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ written: true, count: 2, leftOutForAllergies: 4 });
    expect(plannedNames()).toEqual(['Garden pasta', 'Tacos']);
    expect(db.table('meals').map((meal) => meal.name)).not.toContain('Peanut noodles');
  });

  it('a "new" dish with an empty ingredient list is screened as the saved dish of that name it will be planned as', async () => {
    // The meal service plans the family's saved Pad thai for a dish named
    // alone, an empty ingredient list included, rather than an empty copy.
    answer([
      { date: '2026-09-14', meal_type: 'dinner', ref: 'new', name: 'Pad thai', ingredients: [] },
      { date: '2026-09-15', meal_type: 'dinner', ref: 'new', name: 'Tacos', ingredients: [] },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ written: true, count: 1, leftOutForAllergies: 1 });
    expect(db.table('meal_plans')).toEqual([expect.objectContaining({ plan_date: '2026-09-15', meal_id: 'tacos' })]);
    expect(db.table('meals').map((meal) => meal.id)).toEqual(['pad-thai', 'tacos']);
  });

  it('says the allergies left nothing, when every dish the model chose ran into one', async () => {
    answer([
      { date: '2026-09-14', meal_type: 'dinner', ref: 'meal:pad-thai', name: 'Pad thai' },
      { date: '2026-09-16', meal_type: 'dinner', ref: 'new', name: 'Peanut noodles', ingredients: [{ name: 'noodles' }] },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'plan.everyDishRanIntoAllergy' });
    expect(db.table('meal_plans')).toEqual([]);
  });

  it('control: a model answer with no usable dish at all is still "could not produce"', async () => {
    answer([]);

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'plan.thePlannerCouldNotProduce' });
  });

  it('fails closed, before the model is asked, when the allergies cannot be read', async () => {
    rpc.family_allergies = () => { throw new Error('Fixture allergy read refused'); };

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(db.table('meal_plans')).toEqual([]);
  });
});

describe('S5: the planner is not told to use up food that has already gone off', () => {
  it('offers only still-good expiring items', async () => {
    db.seed('pantry_items', [
      { id: 'p-old', family_id: FAMILY, name: 'chicken breast', expires_at: '2026-09-01' },
      { id: 'p-new', family_id: FAMILY, name: 'spinach', expires_at: '2026-09-15' },
    ]);
    answer([{ date: '2026-09-14', meal_type: 'dinner', ref: 'new', name: 'Spinach omelette', ingredients: [{ name: 'spinach' }, { name: 'eggs' }] }]);

    expect((await POST(request())).status).toBe(200);

    expect(section('Use up these expiring pantry items')).toContain('spinach');
    expect(prompt()).not.toContain('chicken breast');
  });
});
