import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), configured: vi.fn(), complete: vi.fn(), limit: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: mocks.configured,
  resolveProvider: async () => ({ complete: mocks.complete }),
  describeAIError: () => ({ message: 'Generation unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.limit }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_scope: unknown, _feature: unknown, run: (observer: { used: () => void }) => Promise<string>) => run({ used: vi.fn() }),
}));

import { POST } from '@/app/api/ai/meals/plan/route';
import * as mealService from '@/lib/services/meals';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const FAMILY = 'family-one';
const OTHER = 'family-two';
const dinner = { date: '2026-09-14', meal_type: 'dinner', ref: 'recipe:rice-recipe', name: 'Rice' };
const lunch = { date: '2026-09-16', meal_type: 'lunch', ref: 'meal:soup', name: 'Soup' };
const request = (overrides: Record<string, unknown> = {}) => new Request('https://fixture.invalid/api/ai/meals/plan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ weekStart: '2026-09-14', mealTypes: ['dinner', 'lunch'], useExpiring: true, write: true, ...overrides }),
});

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { ingredients: [], recipe_url: null, image_url: null, meal_type: 'dinner' },
    meal_plans: { idempotency_key: null },
  } });
  db.seed('meals', [
    { id: 'rice-old', family_id: FAMILY, name: 'Rice', ingredients: [{ name: 'brown rice', qty: '1', unit: 'cup' }] },
    { id: 'soup', family_id: FAMILY, name: 'Soup', ingredients: [{ name: 'carrots', qty: '2', unit: null }] },
    { id: 'other-meal', family_id: OTHER, name: 'Private meal' },
  ]);
  db.seed('family_recipes', [{ id: 'rice-recipe', family_id: FAMILY, name: 'Rice', category: 'dinner', allergy_flags: [],
    ingredients: [{ name: 'white rice', quantity: '1/2', unit: 'cup' }], source_url: 'https://recipes.example/rice', photo_url: null }]);
  db.seed('meal_plans', [
    { id: 'old-dinner', family_id: FAMILY, meal_id: 'rice-old', plan_date: dinner.date, meal_type: 'dinner', created_by: 'user-one' },
    { id: 'keep-lunch', family_id: FAMILY, meal_id: 'soup', plan_date: dinner.date, meal_type: 'lunch', created_by: 'user-one' },
    { id: 'keep-dinner', family_id: FAMILY, meal_id: 'rice-old', plan_date: lunch.date, meal_type: 'dinner', created_by: 'user-one' },
    { id: 'other-plan', family_id: OTHER, meal_id: 'other-meal', plan_date: dinner.date, meal_type: 'dinner', created_by: 'user-two' },
  ]);
  mocks.context.mockResolvedValue({ user: { id: 'user-one' }, active: {
    familyId: FAMILY, role: 'parent', member: { id: 'member-one' }, family: { timezone: 'Pacific/Kiritimati' },
  } });
  mocks.server.mockResolvedValue(db);
  mocks.configured.mockResolvedValue(true);
  mocks.limit.mockResolvedValue({ ok: true });
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [dinner, lunch] }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('AI planner through the shared persistence service', () => {
  it('saves exact sparse slots and recipe ingredients without changing other meals or families', async () => {
    const response = await POST(request({ familyId: OTHER, userId: 'user-two' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ written: true, count: 2 });
    const rows = db.table('meal_plans');
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining(['keep-lunch', 'keep-dinner', 'other-plan']));
    expect(rows.some(row => row.id === 'old-dinner')).toBe(false);
    const saved = rows.find(row => row.family_id === FAMILY && row.plan_date === dinner.date && row.meal_type === 'dinner')!;
    expect(saved.created_by).toBe('user-one');
    const dish = db.table('meals').find(row => row.id === saved.meal_id)!;
    expect(dish.id).not.toBe('rice-old');
    expect(dish.ingredients).toEqual([{ name: 'white rice', qty: '1/2', unit: 'cup' }]);
    expect(dish.recipe_url).toBe('https://recipes.example/rice');
    expect(db.table('meals').find(row => row.id === 'rice-old')!.ingredients).toEqual([{ name: 'brown rice', qty: '1', unit: 'cup' }]);
  });

  it('makes preview read-only even when the model selects a new dish', async () => {
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ ...dinner, ref: 'new', name: 'Beans' }] }) });
    const before = structuredClone(db.table('meal_plans'));
    expect(await (await POST(request({ write: false }))).json()).toMatchObject({ written: false });
    expect(db.table('meal_plans')).toEqual(before);
    expect(db.table('meals')).toHaveLength(3);
  });

  it('persists bounded generated ingredient quantities including fractions', async () => {
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ ...dinner, ref: 'new', name: 'Bean bowls', ingredients: [
      { name: ' beans ', quantity: '1 1/2', unit: 'cups' }, { name: 'Limes', quantity: 2, unit: null },
    ] }] }) });
    expect((await POST(request())).status).toBe(200);
    expect(db.table('meals').find(row => row.name === 'Bean bowls')!.ingredients).toEqual([
      { name: 'beans', qty: '1 1/2', unit: 'cups' }, { name: 'Limes', qty: '2', unit: null },
    ]);
  });

  it('uses stored recipe ingredients even if generated output tries to replace them', async () => {
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ ...dinner, ingredients: [{ name: 'wrong ingredient', quantity: '9' }] }] }) });
    expect((await POST(request())).status).toBe(200);
    expect(db.table('meals').flatMap(row => row.ingredients as unknown[])).not.toContainEqual(expect.objectContaining({ name: 'wrong ingredient' }));
  });

  it('rechecks recipe ownership at save time and preserves the old plan if ownership changed', async () => {
    const before = structuredClone(db.table('meal_plans'));
    mocks.complete.mockImplementation(async () => {
      db.table('family_recipes')[0].family_id = OTHER;
      return { text: JSON.stringify({ assignments: [dinner] }) };
    });
    expect((await POST(request())).status).toBe(503);
    expect(db.table('meal_plans')).toEqual(before);
  });

  it.each([{ ok: false, error: 'No verified write', code: 'db' }, new Error('Connection lost')])(
    'does not return success without a verified service result: %s', async (failure) => {
      const save = vi.spyOn(mealService, 'planWeek');
      if (failure instanceof Error) save.mockRejectedValueOnce(failure);
      else save.mockResolvedValueOnce(failure as { ok: false; error: string; code: string });
      const response = await POST(request());
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty('written');
    },
  );

  it.each(['2026-02-30', 'invalid'])('rejects an impossible week before provider or database work: %s', async weekStart => {
    expect((await POST(request({ weekStart }))).status).toBe(400);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before planning', async () => {
    mocks.context.mockRejectedValue(new Error('Redirect to login'));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('preserves rate limiting before the provider request', async () => {
    mocks.limit.mockResolvedValue({ ok: false, retryAfter: 60 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('does not change the week when generated ingredients are malformed', async () => {
    const before = structuredClone(db.table('meal_plans'));
    mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ ...dinner, ref: 'new', ingredients: [{ name: '', quantity: {} }] }] }) });
    expect((await POST(request())).status).toBe(422);
    expect(db.table('meal_plans')).toEqual(before);
  });
});
