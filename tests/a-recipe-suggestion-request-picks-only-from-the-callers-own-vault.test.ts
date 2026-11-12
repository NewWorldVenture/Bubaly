// POST /api/recipes/suggest (API-D1DF9BBFEFD5), end to end: the real handler,
// the real getUserContext over an in-memory database seeded with two
// households, the real feature gate, rate limiter, AI allowance and request
// recorder. Only the model is a fixture.
//
// Already proven elsewhere and not repeated here:
//   tests/the-meal-and-recipe-model-endpoints-refuse-like-their-pages.test.ts —
//     trial-expired / closed / feature-off refusals with a mocked resolver;
//   tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts — the Free
//     plan's ten requests, and an unreadable monthly count;
//   tests/an-ai-answer-is-not-built-on-a-read-that-failed.test.ts — the source
//     keeps a failed vault read apart from an empty vault.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { EVERY_ROLE, HOUSEHOLD_A, HOUSEHOLD_B, seedTwoHouseholds, userA, type HouseholdPlan } from './helpers/two-households-every-role';
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

const { POST } = await import('@/app/api/recipes/suggest/route');

const RECIPE_A = '00000000-0000-4000-8000-0000000a0301';
const RECIPE_A2 = '00000000-0000-4000-8000-0000000a0302';
const RECIPE_B = '00000000-0000-4000-8000-0000000b0301';
const INTERNAL = 'relation "family_recipes" internal detail 0xDEAD';

let db: InMemorySupabase;
let clock = Date.parse('2026-10-14T00:00:00.000Z');

function build(userId: string | null, plan: HouseholdPlan = 'plus') {
  const made = createInMemorySupabase({
    userId,
    rpc: {
      rate_limit_hit: rateLimitHit,
      is_super_admin: () => false,
      count_family_ai_requests_month: (args, mem) => mem.table('ai_requests').filter((r) => r.family_id === args.p_family_id).length,
    },
  });
  seedTwoHouseholds(made, plan);
  made.seed('family_recipes', [
    { id: RECIPE_A, family_id: HOUSEHOLD_A, name: 'Lentil soup', cuisine: 'French', category: 'dinner', tags: [], ingredients: [{ name: 'lentils' }], photo_url: null, is_favorite: true },
    { id: RECIPE_A2, family_id: HOUSEHOLD_A, name: 'Tomato pasta', cuisine: 'Italian', category: 'dinner', tags: [], ingredients: [{ name: 'tomatoes' }], photo_url: 'https://img.example.com/pasta.jpg', is_favorite: false },
    { id: RECIPE_B, family_id: HOUSEHOLD_B, name: 'Household B secret stew', cuisine: 'Nordic', category: 'dinner', tags: [], ingredients: [{ name: 'herring' }], photo_url: null, is_favorite: true },
  ]);
  return made;
}

function signIn(userId: string | null, plan: HouseholdPlan = 'plus') {
  db = build(userId, plan);
  h.db = db;
}

const suggest = (body: unknown = { constraint: 'something warm' }) =>
  POST(new NextRequest('http://localhost/api/recipes/suggest', { method: 'POST', body: JSON.stringify(body) }));

const modelPicks = (...ids: string[]) => ({ text: JSON.stringify({ picks: ids.map((id) => ({ id, reason: 'Warm and quick.' })) }), model: 'fixture-model', usage: { input_tokens: 10, output_tokens: 10 } });

beforeEach(() => {
  // A fresh minute per case, so the in-process limiter's buckets from one case never refuse the next.
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  h.complete.mockReset().mockResolvedValue(modelPicks(RECIPE_A2, RECIPE_A));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('API-D1DF9BBFEFD5 POST /api/recipes/suggest', () => {
  it('API-D1DF9BBFEFD5 refuses a signed-out caller with 401, before the limiter, the vault and the model', async () => {
    signIn(null);

    const response = await suggest();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'suggest.unauthorized' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toEqual([]);
    expect(db.table('ai_requests')).toEqual([]);
    expect(db.log.map((entry) => entry.table)).not.toContain('family_recipes');
  });

  it.each(EVERY_ROLE)('API-D1DF9BBFEFD5 a household-A %s gets picks from household A\'s vault, recorded as one request of theirs', async (role: MemberRole) => {
    signIn(userA(role));

    const response = await suggest();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      picks: [
        { id: RECIPE_A2, name: 'Tomato pasta', cuisine: 'Italian', category: 'dinner', photoUrl: 'https://img.example.com/pasta.jpg', reason: 'Warm and quick.' },
        { id: RECIPE_A, name: 'Lentil soup', cuisine: 'French', category: 'dinner', photoUrl: null, reason: 'Warm and quick.' },
      ],
    });
    expect(h.complete).toHaveBeenCalledTimes(1);
    const requests = db.table('ai_requests');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ family_id: HOUSEHOLD_A, requested_by: userA(role) });
    // A suggestion reads the vault; it writes nothing to it.
    expect(db.table('family_recipes')).toHaveLength(3);
  });

  it('API-D1DF9BBFEFD5 household B\'s recipes never reach the model, and an id of B\'s the model names is dropped', async () => {
    signIn(userA('parent'));
    h.complete.mockResolvedValue(modelPicks(RECIPE_B, RECIPE_A));

    const response = await suggest();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.picks.map((pick: { id: string }) => pick.id)).toEqual([RECIPE_A]);
    const prompt = JSON.stringify(h.complete.mock.calls[0][0]);
    expect(prompt).toContain('Lentil soup');
    expect(prompt).not.toContain('Household B secret stew');
    expect(prompt).not.toContain(RECIPE_B);
    expect(db.table('ai_requests').map((row) => row.family_id)).toEqual([HOUSEHOLD_A]);
  });

  it('API-D1DF9BBFEFD5 a household-B parent is suggested only B\'s recipe', async () => {
    signIn('00000000-0000-4000-8000-0000000b0100');
    h.complete.mockResolvedValue(modelPicks(RECIPE_A, RECIPE_B));

    const response = await suggest();

    expect(response.status).toBe(200);
    expect((await response.json()).picks.map((pick: { id: string }) => pick.id)).toEqual([RECIPE_B]);
    expect(JSON.stringify(h.complete.mock.calls[0][0])).not.toContain('Lentil soup');
  });

  it('API-D1DF9BBFEFD5 a trial-expired household A is refused from its own data, before the limiter and the model', async () => {
    signIn(userA('parent'), 'trial_expired');

    const response = await suggest();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'trial_expired' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('rate_limits')).toEqual([]);
    expect(db.log.map((entry) => entry.table)).not.toContain('family_recipes');
  });

  it('API-D1DF9BBFEFD5 the sixteenth request in a minute is refused 429 with no model call', async () => {
    signIn(userA('teen'));
    for (let i = 0; i < 15; i += 1) expect((await suggest()).status).toBe(200);
    h.complete.mockClear();

    const response = await suggest();

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(15);
  });

  it('API-D1DF9BBFEFD5 a vault read that fails is 503, not an empty vault, and reaches no model', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table) => (table === 'family_recipes' ? { message: INTERNAL } : null));

    const response = await suggest();

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'suggest.recipeDataIsTemporarilyUnavailable' });
    expect(text).not.toContain(INTERNAL);
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toEqual([]);
  });

  it('API-D1DF9BBFEFD5 a model that fails is 502 with no internal text, and the request is recorded as failed', async () => {
    signIn(userA('adult'));
    h.complete.mockRejectedValue(new Error(INTERNAL));

    const response = await suggest();

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'suggest.aiIsTemporarilyUnavailable' });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(db.table('ai_requests')[0]).toMatchObject({ family_id: HOUSEHOLD_A, status: 'failed' });
  });

  it('API-D1DF9BBFEFD5 an empty vault answers empty without asking the model or spending the allowance', async () => {
    signIn(userA('parent'));
    db.replace('family_recipes', db.table('family_recipes').filter((row) => row.family_id !== HOUSEHOLD_A));

    const response = await suggest();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ picks: [], empty: true });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toEqual([]);
  });
});
