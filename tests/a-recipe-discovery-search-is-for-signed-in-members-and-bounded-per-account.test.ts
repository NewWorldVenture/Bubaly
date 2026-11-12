// GET /api/recipes/search (API-EECB4738F390), end to end: the real handler,
// the real requireUserContext over an in-memory database seeded with two
// households, the real two-layer rate limiter and the real TheMealDB adapter.
// Only the network is a fixture (a stubbed `fetch`).
//
// Already proven elsewhere and not repeated here:
//   tests/a-recipe-search-outage-is-not-no-recipes.test.ts — a provider
//     outage, rate limit, network error or non-JSON reply is 502, and a search
//     that matches nothing is an empty 200.
//
// The route reads and writes no household rows; "another household" here is
// the per-account limiter: one account's searches do not spend another's.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { EVERY_ROLE, USER_B, seedTwoHouseholds, userA } from './helpers/two-households-every-role';
import type { MemberRole } from '@/lib/constants/roles';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));

const { GET } = await import('@/app/api/recipes/search/route');

const MEAL = {
  idMeal: '52771', strMeal: 'Spicy Arrabiata Penne', strCategory: 'Vegetarian', strArea: 'Italian',
  strInstructions: 'Boil the pasta.', strMealThumb: 'https://img.example.com/penne.jpg', strTags: 'Pasta,Curry',
  strIngredient1: 'penne rigate', strMeasure1: '1 pound', strSource: 'https://recipes.example.com/penne',
};

let db: InMemorySupabase;
let fetchCalls: string[];
let clock = Date.parse('2026-10-14T00:00:00.000Z');

function signIn(userId: string | null, rpc: Record<string, (args: Record<string, unknown>, mem: InMemorySupabase) => unknown> = { rate_limit_hit: rateLimitHit }) {
  db = createInMemorySupabase({ userId, rpc });
  seedTwoHouseholds(db);
  h.db = db;
}

const search = (q: string) => GET(new NextRequest(`http://localhost/api/recipes/search?q=${encodeURIComponent(q)}`));

beforeEach(() => {
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url));
    return Response.json({ meals: [MEAL] });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('API-EECB4738F390 GET /api/recipes/search', () => {
  it('API-EECB4738F390 refuses a signed-out caller with 401, before the limiter and the provider', async () => {
    signIn(null);

    const response = await search('penne');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'search.unauthorized' });
    expect(fetchCalls).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
  });

  it.each(EVERY_ROLE)('API-EECB4738F390 a household-A %s gets normalized results with the raw provider payload stripped', async (role: MemberRole) => {
    signIn(userA(role));

    const response = await search('penne');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['recipes']);
    expect(body.recipes).toHaveLength(1);
    expect(body.recipes[0]).toMatchObject({
      sourceProvider: 'themealdb', sourceRecipeId: '52771', name: 'Spicy Arrabiata Penne', cuisine: 'Italian',
      category: 'vegetarian', tags: ['Pasta', 'Curry'], sourceUrl: 'https://recipes.example.com/penne',
    });
    expect(body.recipes[0]).not.toHaveProperty('raw');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('search.php?s=penne');
    // One durable hit, and no household row written.
    expect(db.table('rate_limits')).toHaveLength(1);
    expect(db.log.map((entry) => entry.table).filter((table) => !['family_members', 'families', 'user_preferences'].includes(table))).toEqual([]);
  });

  it('API-EECB4738F390 an empty query answers an empty list without calling the provider', async () => {
    signIn(userA('child'));

    const response = await search('   ');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [] });
    expect(fetchCalls).toEqual([]);
  });

  it('API-EECB4738F390 the thirty-first search in a minute is refused 429, and does not spend household B\'s searches', async () => {
    signIn(userA('teen'));
    for (let i = 0; i < 30; i += 1) expect((await search('penne')).status).toBe(200);
    fetchCalls = [];

    const refused = await search('penne');

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'search.slowDownAMomentAnd' });
    expect(fetchCalls).toEqual([]);

    const shared = db.table('rate_limits');
    signIn(USER_B);
    db.replace('rate_limits', shared);
    expect((await search('penne')).status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });

  it('API-EECB4738F390 a limiter that cannot be read fails closed (429) and reaches no provider', async () => {
    signIn(userA('parent'), { rate_limit_hit: () => { throw new Error('canceling statement due to statement timeout'); } });

    const response = await search('penne');

    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).not.toContain('statement timeout');
    expect(fetchCalls).toEqual([]);
  });
});
