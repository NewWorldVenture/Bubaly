import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// Execute the actual route, bearer resolver, role helper and installed SDK.
// Only request-cookie construction, provider transport, entitlement outcome and
// unrelated manifest rendering are controlled. Never contact an auth provider.
const h = vi.hoisted(() => ({
  cookieClient: null as unknown,
  cookieFactory: vi.fn(),
  requests: [] as { path: string; actor: string }[],
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => h.cookieFactory() }));
vi.mock('@/lib/server/feature-entitlement', () => ({
  resolveFeatureEntitlement: async () => ({ allowed: false, reason: 'plan', needLevel: 2, planLevel: 0 }),
}));
vi.mock('@/lib/server/ai-request-context', () => ({
  assertAIRequestFamily: () => null,
  getAIRequestTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: () => [] }));
vi.mock('@/lib/ai/action-tools', () => ({ buildActionTools: () => [], mergeToolSets: () => [] }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => false,
  describeAIError: (error: unknown) => ({ message: error instanceof Error ? error.message : 'Unexpected fixture error' }),
}));
// POST-only collaborators are outside the GET contract tested below.
vi.mock('@/lib/ai/assistant-engine', () => ({}));
vi.mock('@/lib/server/ai-access', () => ({}));
vi.mock('@/lib/server/ensure-family', () => ({}));
vi.mock('@/lib/server/plan', () => ({}));
vi.mock('@/lib/server/rate-limit', () => ({}));
vi.mock('@/lib/server/rate-limit-db', () => ({}));
vi.mock('@/lib/server/bounded-request-body', () => ({}));

import { GET } from '@/app/api/ai/route';
import { isSuperAdmin } from '@/lib/supabase/auth';

type Actor = 'A' | 'B';
const ORIGIN = 'https://route-principal-fixture.invalid';
const token = (actor: Actor) => `synthetic-user-${actor}`;
const users = {
  A: { id: '00000000-0000-4000-8000-00000000000a', email: 'admin-a@fixture.invalid' },
  B: { id: '00000000-0000-4000-8000-00000000000b', email: 'member-b@fixture.invalid' },
};

function client(actor: Actor | null): SupabaseClient<Database> {
  return createClient<Database>(ORIGIN, 'synthetic-anon-key', {
    global: actor ? { headers: { Authorization: `Bearer ${token(actor)}` } } : {},
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon-key');
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  h.requests = [];
  h.cookieFactory.mockReset().mockImplementation(async () => h.cookieClient);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error('Unexpected external request blocked');
    const authorization = request.headers.get('authorization');
    const actor: Actor = authorization === `Bearer ${token('A')}` ? 'A' : 'B';
    h.requests.push({ path: url.pathname, actor });
    if (url.pathname === '/auth/v1/user') {
      if (authorization === 'Bearer invalid') return Response.json({ message: 'Invalid JWT', error_code: 'bad_jwt' }, { status: 401 });
      return Response.json({ ...users[actor], aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2020-01-01T00:00:00Z' });
    }
    if (url.pathname === '/rest/v1/family_members') return Response.json([{ id: `member-${actor}`, user_id: users[actor].id, family_id: `family-${actor}`, role: 'parent', is_active: true }]);
    if (url.pathname === '/rest/v1/families') return Response.json([{ id: `family-${actor}`, name: `Synthetic ${actor}`, timezone: 'UTC' }]);
    if (url.pathname === '/rest/v1/user_preferences') return Response.json({ active_family_id: `family-${actor}` });
    if (url.pathname === '/rest/v1/rpc/is_super_admin') return Response.json(actor === 'A');
    throw new Error(`Unexpected provider path blocked: ${url.pathname}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cases: { name: string; bearer: Actor | null; cookie: Actor | null; status: number }[] = [
  { name: 'ordinary bearer B cannot borrow admin cookie A', bearer: 'B', cookie: 'A', status: 403 },
  { name: 'admin bearer A needs no browser cookie', bearer: 'A', cookie: null, status: 200 },
  { name: 'ordinary B with matching credentials stays refused', bearer: 'B', cookie: 'B', status: 403 },
  { name: 'admin A with matching credentials remains allowed', bearer: 'A', cookie: 'A', status: 200 },
  { name: 'cookie-only admin remains allowed', bearer: null, cookie: 'A', status: 200 },
  { name: 'cookie-only ordinary member stays refused', bearer: null, cookie: 'B', status: 403 },
];

describe('the API plan override belongs to the authenticated request principal', () => {
  it.each(cases)('$name', async ({ bearer, cookie, status }) => {
    h.cookieClient = client(cookie);
    const request = new NextRequest('https://app.fixture.invalid/api/ai', {
      headers: bearer ? { authorization: `Bearer ${token(bearer)}` } : {},
    });
    const response = await GET(request);
    expect(response.status).toBe(status);
    const principal = bearer ?? cookie;
    if (status === 200) expect(await response.json()).toMatchObject({ family: { id: `family-${principal}` } });
    if (bearer) {
      expect(h.cookieFactory).not.toHaveBeenCalled();
      expect(h.requests.filter((r) => r.path === '/rest/v1/rpc/is_super_admin')).toEqual([{ path: '/rest/v1/rpc/is_super_admin', actor: bearer }]);
    }
  });

  it('an invalid bearer never falls back to the admin cookie', async () => {
    h.cookieClient = client('A');
    const response = await GET(new NextRequest('https://app.fixture.invalid/api/ai', { headers: { authorization: 'Bearer invalid' } }));
    expect(response.status).toBe(401);
    expect(h.cookieFactory).not.toHaveBeenCalled();
    expect(h.requests.some((r) => r.path === '/rest/v1/rpc/is_super_admin')).toBe(false);
  });

  it.each(['A', 'B'] as const)('the default page role helper still resolves cookie user %s', async (actor) => {
    h.cookieClient = client(actor);
    expect(await isSuperAdmin()).toBe(actor === 'A');
    expect(h.cookieFactory).toHaveBeenCalledOnce();
    expect(h.requests.filter((r) => r.path === '/rest/v1/rpc/is_super_admin')).toEqual([{ path: '/rest/v1/rpc/is_super_admin', actor }]);
  });
});
