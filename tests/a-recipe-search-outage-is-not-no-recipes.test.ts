// A recipe-search outage is reported as an outage, not as "No recipes found".
//
// searchAllProviders ran every enabled provider through Promise.allSettled and
// skipped the rejected ones. TheMealDB is the only provider, so when it was
// down, slow, rate-limited or answered garbage, the search resolved to [] and
// GET /api/recipes/search answered 200 { recipes: [] } — its own 502 "recipe
// search is temporarily unavailable" could never fire — and the Discover screen
// said "No recipes found. Try another search."
//
// The real route and the real TheMealDB adapter; only the network is a fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one' } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

import { GET } from '@/app/api/recipes/search/route';

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const search = (q: string) => GET(new NextRequest(`https://fixture.invalid/api/recipes/search?q=${encodeURIComponent(q)}`));

describe('GET /api/recipes/search', () => {
  it.each([
    ['the provider answers 503', () => new Response('Service Unavailable', { status: 503 })],
    ['the provider rate-limits the search', () => new Response('Too Many Requests', { status: 429 })],
    ['the provider cannot be reached', () => { throw new TypeError('fetch failed'); }],
    ['the provider answers something that is not JSON', () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('answers 502 when %s', async (_case, answer) => {
    h.fetch.mockImplementation(async () => answer());

    const response = await search('tacos');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'search.recipeSearchIsTemporarilyUnavailable' });
  });

  it('control: a search that genuinely matches nothing is still an empty 200', async () => {
    h.fetch.mockImplementation(async () => Response.json({ meals: null }));

    const response = await search('zzzz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipes: [] });
  });
});
