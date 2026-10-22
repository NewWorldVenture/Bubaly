import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserContext } from '@/lib/supabase/auth';

// The SDK and SSR cookie reader are real. Only the Auth HTTP boundary and the
// request's client factory are synthetic. The provider accepts one exact test
// token; this proves which facts the application uses, not live JWT validation.
const h = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.client }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));

import { aal2Verdict, readAssurance, requireAal2 } from '@/lib/auth/require-aal2';
import { decideSuperAdminAssurance, superAdminAssurance } from '@/lib/auth/super-admin-assurance';

const ORIGIN = 'https://assurance-fixture.supabase.co';
const KEY = 'sb-assurance-fixture-auth-token';
const USER = '00000000-0000-4000-8000-000000000001';
const FACTOR = { id: '00000000-0000-4000-8000-000000000002', factor_type: 'totp', status: 'verified', created_at: '2026-01-01T00:00:00Z' };
const clients: SupabaseClient[] = [];
const encode = (value: unknown) => `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const payload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function fixture(options: {
  level?: string | null;
  storedFactors?: unknown;
  providerFactors?: unknown;
  absent?: boolean;
  providerStatus?: number;
  providerThrows?: boolean;
} = {}) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const claims = { sub: USER, aud: 'authenticated', exp: expires, aal: options.level === undefined ? 'aal1' : options.level };
  const token = `${payload({ alg: 'HS256', typ: 'JWT' })}.${payload(claims)}.${payload('synthetic-signature')}`;
  const identity = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'admin@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const storedUser = { ...identity, ...(options.storedFactors === undefined ? {} : { factors: options.storedFactors }) };
  const providerUser = { ...identity, factors: options.providerFactors ?? [FACTOR] };
  const session = { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: expires, expires_in: 3600, user: storedUser };
  const values = new Map<string, string>(options.absent ? [] : [[KEY, encode(session)]]);
  const requests: { path: string; authorization: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = headers.get('authorization');
    requests.push({ path: url.pathname, authorization });
    if (url.origin !== ORIGIN || url.pathname !== '/auth/v1/user') throw new Error('Unexpected synthetic Auth request');
    if (options.providerThrows) throw new TypeError('Synthetic Auth transport failed');
    const status = authorization === `Bearer ${token}` ? (options.providerStatus ?? 200) : 401;
    return status === 200 ? Response.json(providerUser) : Response.json({ code: status === 401 ? 'bad_jwt' : 'unexpected_failure', message: 'Synthetic Auth refusal' }, { status });
  };
  const client = createServerClient(ORIGIN, 'synthetic-anon', {
    global: { fetch: fetcher },
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true, storageKey: KEY },
    cookies: {
      getAll: () => [...values].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.options.maxAge === 0) values.delete(cookie.name);
          else values.set(cookie.name, cookie.value);
        }
      },
    },
  });
  clients.push(client);
  h.client = client;
  return { client, token, values, requests, providerUser };
}

function context(role: 'parent' | 'adult' | 'teen'): UserContext {
  const stamps = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const active: UserContext['active'] = {
    familyId: 'family-1', role,
    family: {
      id: 'family-1', name: 'Assurance fixture', avatar_url: null, cover_url: null,
      address: null, family_code: null, timezone: 'UTC', trial_ends_at: null,
      closed_at: null, created_by: USER, ...stamps,
    },
    member: {
      id: 'member-1', family_id: 'family-1', user_id: USER, role,
      display_name: 'Assurance actor', color: null, birthday: null,
      email: 'admin@example.invalid', phone: null, avatar_url: null,
      is_active: true, onboarding_key: null, ...stamps,
    },
  };
  return { user: { id: USER, email: 'admin@example.invalid' }, memberships: [active], active };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.auth.stopAutoRefresh();
  h.client = null;
  vi.restoreAllMocks();
});

describe('server assurance uses the authenticated user, not cookie factor claims', () => {
  it.each([
    ['missing', undefined],
    ['removed', []],
    ['changed to unverified', [{ ...FACTOR, status: 'unverified' }]],
  ])('an enrolled admin still needs a code when cookie factors are %s', async (_label, storedFactors) => {
    const f = fixture({ storedFactors });
    const originalCookie = [...f.values];
    // This is the earlier authentication the admin/page guard already does.
    // A verified getUser result does not replace unsigned session.user data.
    const authenticated = await f.client.auth.getUser();
    expect(authenticated.error).toBeNull();
    expect(authenticated.data.user?.factors).toEqual([FACTOR]);
    expect([...f.values]).toEqual(originalCookie);
    const read = await readAssurance(f.client);
    expect(read).toEqual({ ok: true, assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } });
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: false, reason: 'needs_code' });
    expect(f.requests).toEqual([
      { path: '/auth/v1/user', authorization: `Bearer ${f.token}` },
      { path: '/auth/v1/user', authorization: `Bearer ${f.token}` },
    ]);
  });

  it('the actual super-admin assurance caller refuses the stripped-factor session', async () => {
    const f = fixture({ storedFactors: [] });
    expect((await f.client.auth.getUser()).data.user?.id).toBe(USER);
    await expect(superAdminAssurance()).resolves.toEqual({ ok: false, reason: 'needs_code' });
  });

  it.each(['parent', 'adult'] as const)('the actual %s page verdict and redirect retain their step-up gate', async (role) => {
    const f = fixture({ storedFactors: [] });
    expect((await f.client.auth.getUser()).data.user?.id).toBe(USER);
    await expect(aal2Verdict(context(role), 'documents', '/dashboard/documents')).resolves.toEqual({ action: 'step_up', reason: 'needs_code', to: '/auth/step-up?next=%2Fdashboard%2Fdocuments' });
    await expect(requireAal2(context(role), 'documents', '/dashboard/documents')).rejects.toThrow('REDIRECT:/auth/step-up?next=%2Fdashboard%2Fdocuments');
  });

  it.each([
    ['no enrolled factor', 'aal1', [], 'aal1'],
    ['only an unverified factor', 'aal1', [{ ...FACTOR, status: 'unverified' }], 'aal1'],
    ['already stepped up', 'aal2', [FACTOR], 'aal2'],
  ])('control: %s retains access', async (_label, level, providerFactors, nextLevel) => {
    const f = fixture({ level, providerFactors, storedFactors: [] });
    const read = await readAssurance(f.client);
    expect(read).toEqual({ ok: true, assurance: { currentLevel: level, nextLevel } });
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: true });
  });

  it('control: the existing non-manager role policy remains unchanged', async () => {
    fixture({ storedFactors: [], providerFactors: [FACTOR] });
    await expect(aal2Verdict(context('teen'), 'money', '/dashboard/expenses')).resolves.toEqual({ action: 'allow' });
  });

  it('missing session is unreadable, not proof of an account without factors', async () => {
    const f = fixture({ absent: true });
    const read = await readAssurance(f.client);
    expect(read.ok).toBe(false);
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: false, reason: 'assurance_unreadable' });
    expect(f.requests).toEqual([]);
  });

  it.each([null, 'unexpected-aal'])('an unusable current level %j cannot authorize a server action', async (level) => {
    const f = fixture({ level, providerFactors: [], storedFactors: [] });
    const read = await readAssurance(f.client);
    expect(read.ok).toBe(false);
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: false, reason: 'assurance_unreadable' });
  });

  it.each([401, 503])('an Auth HTTP %i response fails closed without a factor-free fallback', async (providerStatus) => {
    const f = fixture({ storedFactors: [], providerStatus });
    const read = await readAssurance(f.client);
    expect(read.ok).toBe(false);
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: false, reason: 'assurance_unreadable' });
    expect(f.requests).toEqual([{ path: '/auth/v1/user', authorization: `Bearer ${f.token}` }]);
  });

  it('a thrown Auth transport failure fails closed', async () => {
    const f = fixture({ storedFactors: [], providerThrows: true });
    const read = await readAssurance(f.client);
    expect(read.ok).toBe(false);
    expect(decideSuperAdminAssurance(read)).toEqual({ ok: false, reason: 'assurance_unreadable' });
    expect(f.requests).toHaveLength(1);
  });
});
