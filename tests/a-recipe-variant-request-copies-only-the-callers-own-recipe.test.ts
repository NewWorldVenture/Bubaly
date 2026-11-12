// POST /api/recipes/transform (API-28B5240AADC2), end to end: the real handler,
// the real getUserContext over an in-memory database seeded with two
// households, the real feature gate, rate limiter, AI allowance and request
// recorder. Only the model is a fixture.
//
// Already proven elsewhere and not repeated here:
//   tests/the-meal-and-recipe-model-endpoints-refuse-like-their-pages.test.ts —
//     trial-expired / closed / feature-off refusals with a mocked resolver;
//   tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts — the Free
//     plan's ten requests;
//   tests/an-ai-recipe-variant-keeps-its-servings.test.ts — the variant keeps
//     its source's servings;
//   tests/household-text-reaches-the-meal-models-fenced.test.ts — the recipe
//     text reaches the model fenced as untrusted.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { EVERY_ROLE, HOUSEHOLD_A, HOUSEHOLD_B, USER_B, seedTwoHouseholds, userA, type HouseholdPlan } from './helpers/two-households-every-role';
import type { MemberRole } from '@/lib/constants/roles';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'fixture-model', complete: h.complete }),
}));

const { POST } = await import('@/app/api/recipes/transform/route');

const RECIPE_A = '00000000-0000-4000-8000-0000000a0301';
const RECIPE_B = '00000000-0000-4000-8000-0000000b0301';
const INTERNAL = 'relation "family_recipes" internal detail 0xDEAD';

const VARIANT = {
  name: 'Lighter lentil soup', description: 'Less salt.',
  ingredients: [{ name: 'lentils', quantity: '1', unit: 'cup' }],
  instructions: [{ step: 1, text: 'Simmer.' }], notes: 'Season to taste.', tags: ['lighter'],
};

let db: InMemorySupabase;
let clock = Date.parse('2026-10-14T00:00:00.000Z');

function signIn(userId: string | null, plan: HouseholdPlan = 'plus') {
  db = createInMemorySupabase({
    userId,
    rpc: {
      rate_limit_hit: rateLimitHit,
      is_super_admin: () => false,
      count_family_ai_requests_month: (args, mem) => mem.table('ai_requests').filter((r) => r.family_id === args.p_family_id).length,
    },
  });
  seedTwoHouseholds(db, plan);
  db.seed('family_recipes', [
    { id: RECIPE_A, family_id: HOUSEHOLD_A, name: 'Lentil soup', cuisine: 'French', category: 'dinner', servings: 6, allergy_flags: [],
      ingredients: [{ name: 'lentils', quantity: '2', unit: 'cups' }], instructions: [{ step: 1, text: 'Simmer.' }], photo_url: null },
    { id: RECIPE_B, family_id: HOUSEHOLD_B, name: 'Household B secret stew', cuisine: 'Nordic', category: 'dinner', servings: 2, allergy_flags: [],
      ingredients: [{ name: 'herring', quantity: '1', unit: '' }], instructions: [{ step: 1, text: 'Stew.' }], photo_url: null },
  ]);
  h.db = db;
}

const transform = (recipeId: string, actionId = 'healthier') =>
  POST(new NextRequest('http://localhost/api/recipes/transform', { method: 'POST', body: JSON.stringify({ recipeId, actionId }) }));

const snapshot = (table: string) => JSON.stringify(db.table(table));

beforeEach(() => {
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  h.complete.mockReset().mockResolvedValue({ text: JSON.stringify(VARIANT), model: 'fixture-model', usage: { input_tokens: 10, output_tokens: 10 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('API-28B5240AADC2 POST /api/recipes/transform', () => {
  it('API-28B5240AADC2 refuses a signed-out caller with 401 and writes nothing', async () => {
    signIn(null);
    const before = snapshot('family_recipes');

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'transform.unauthorized' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(snapshot('family_recipes')).toBe(before);
    expect(db.table('rate_limits')).toEqual([]);
    expect(db.table('ai_requests')).toEqual([]);
  });

  it.each(EVERY_ROLE)('API-28B5240AADC2 a household-A %s saves a variant of A\'s recipe into household A', async (role: MemberRole) => {
    signIn(userA(role));

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['id', 'ok']);
    expect(body.ok).toBe(true);
    const saved = db.table('family_recipes').filter((row) => row.id === body.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      family_id: HOUSEHOLD_A, created_by: userA(role), name: 'Lighter lentil soup', servings: 6,
      ai_generated: true, source_provider: 'bubaly_ai', source_recipe_id: RECIPE_A, tags: ['lighter', 'ai:healthier'],
    });
    expect(db.table('family_recipes')).toHaveLength(3);
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(db.table('ai_requests')[0]).toMatchObject({ family_id: HOUSEHOLD_A, requested_by: userA(role) });
  });

  it('API-28B5240AADC2 household B\'s recipe id is not found for household A: not read into a prompt, not copied, nothing spent', async () => {
    signIn(userA('parent'));
    const before = snapshot('family_recipes');

    const response = await transform(RECIPE_B);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'transform.recipeNotFound' });
    expect(text).not.toContain('Household B secret stew');
    expect(h.complete).not.toHaveBeenCalled();
    expect(snapshot('family_recipes')).toBe(before);
    expect(db.table('ai_requests')).toEqual([]);
  });

  it('API-28B5240AADC2 household B\'s parent cannot copy household A\'s recipe either', async () => {
    signIn(USER_B);
    const before = snapshot('family_recipes');

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
    expect(snapshot('family_recipes')).toBe(before);
  });

  it('API-28B5240AADC2 a trial-expired household A is refused before the limiter, the read and the model', async () => {
    signIn(userA('parent'), 'trial_expired');

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'trial_expired' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toEqual([]);
    expect(db.log.map((entry) => entry.table)).not.toContain('family_recipes');
  });

  it('API-28B5240AADC2 the thirteenth variant in a minute is refused 429 with no model call and no row', async () => {
    signIn(userA('child'));
    for (let i = 0; i < 12; i += 1) expect((await transform(RECIPE_A)).status).toBe(200);
    h.complete.mockClear();

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(429);
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('family_recipes')).toHaveLength(2 + 12);
  });

  it('API-28B5240AADC2 a recipe read that fails is 503, not "not found", with no internal text and no model call', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table) => (table === 'family_recipes' ? { message: INTERNAL } : null));

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'transform.recipeDataIsTemporarilyUnavailable' });
    expect(text).not.toContain(INTERNAL);
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toEqual([]);
  });

  it('API-28B5240AADC2 a model that fails is 502 and saves no variant', async () => {
    signIn(userA('adult'));
    h.complete.mockRejectedValue(new Error(INTERNAL));

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'transform.aiIsTemporarilyUnavailable' });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('family_recipes')).toHaveLength(2);
    expect(db.table('ai_requests')[0]).toMatchObject({ status: 'failed' });
  });

  it('API-28B5240AADC2 a variant insert that fails is a 500 with no internal text, never ok', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table, calls) => (table === 'family_recipes' && calls.some((call) => call.method === 'insert') ? { message: INTERNAL } : null));

    const response = await transform(RECIPE_A);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'transform.couldNotSaveVariant' });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('family_recipes')).toHaveLength(2);
  });
});
