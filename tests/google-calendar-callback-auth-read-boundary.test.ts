import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Literal callback boundary only. No assertion that an installed Auth SDK emits
// contradictory error+user records; those are defensive admission controls.
const boundary = vi.hoisted(() => ({ fetchCalls: 0, defaultFetchCalls: 0, forbiddenFactories: [] as string[] }));
const fake = vi.hoisted(() => ({
  auth: { data: { user: { id: 'session-user' } as { id: string } | null }, error: null as unknown },
  authThrown: null as unknown,
  key: true,
  merge: { ok: true } as { ok: boolean; reason?: string; error?: unknown },
  calls: [] as Array<{ op: string; args: unknown[] }>,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: (url: URL) => {
      const cookies = new Map<string, Record<string, unknown>>();
      return {
        status: 307,
        headers: { get: (name: string) => name.toLowerCase() === 'location' ? String(url) : null },
        cookies: {
          set: (name: string, value: string, options: Record<string, unknown>) => { cookies.set(name, { value, ...options }); },
          get: (name: string) => cookies.get(name),
        },
      };
    },
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => {
    fake.calls.push({ op: 'server', args: [] });
    return { auth: { getUser: async () => { fake.calls.push({ op: 'auth', args: [] }); if (fake.authThrown) throw fake.authThrown; return fake.auth; } } };
  },
}));
vi.mock('@/lib/google', () => ({
  exchangeGoogleCode: async (...args: unknown[]) => {
    fake.calls.push({ op: 'exchange', args });
    return { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 123 };
  },
  googleCalendarRedirectUri: (origin: string) => `${origin}/api/google/calendar/callback`,
}));
vi.mock('@/lib/google-token-storage', () => ({
  canStoreGoogleToken: () => { fake.calls.push({ op: 'key', args: [] }); return fake.key; },
  encodeGoogleToken: (token: unknown) => { fake.calls.push({ op: 'encode', args: [token] }); return 'synthetic-encrypted-envelope'; },
}));
vi.mock('@/lib/preferences/notification-prefs', () => ({
  // Eager transform is a route wiring/refusal stub, not the real helper's
  // read-before-transform, encryption, or compare-and-set semantics.
  mergeNotificationPrefs: async (_db: unknown, userId: string, transform: (prefs: Record<string, unknown>) => unknown) => {
    const call: { op: string; args: unknown[] } = { op: 'merge', args: [userId] };
    fake.calls.push(call);
    call.args.push(transform({ existing: 'keep-me' }));
    return fake.merge;
  },
}));

// Known forbidden boundary imports fail in their mock factories before any
// implementation is loaded. Default CI observes only this closed mock graph;
// local adapter runs additionally retain their admitted external load veto.
vi.mock('@supabase/supabase-js', () => {
  boundary.forbiddenFactories.push('@supabase/supabase-js');
  throw new Error('Forbidden SDK implementation import in callback fixture');
});
vi.mock('@supabase/ssr', () => {
  boundary.forbiddenFactories.push('@supabase/ssr');
  throw new Error('Forbidden SSR implementation import in callback fixture');
});
vi.mock('@supabase/auth-js', () => {
  boundary.forbiddenFactories.push('@supabase/auth-js');
  throw new Error('Forbidden Auth SDK implementation import in callback fixture');
});
vi.mock('@/lib/supabase/auth', () => {
  boundary.forbiddenFactories.push('@/lib/supabase/auth');
  throw new Error('Forbidden Auth implementation import in callback fixture');
});
vi.mock('next/cache', () => {
  boundary.forbiddenFactories.push('next/cache');
  throw new Error('Forbidden cache implementation import in callback fixture');
});
vi.mock('@/lib/ai/provider', () => {
  boundary.forbiddenFactories.push('@/lib/ai/provider');
  throw new Error('Forbidden provider implementation import in callback fixture');
});
vi.mock('@/lib/sync/crypto', () => {
  boundary.forbiddenFactories.push('@/lib/sync/crypto');
  throw new Error('Forbidden encryption implementation import in callback fixture');
});

type ActualGuard = { snapshot(): { forbiddenImports: string[]; fetchCalls: number }; recordFetch(): never };
const defaultLiteralGuard: ActualGuard = {
  snapshot: () => ({ forbiddenImports: [...boundary.forbiddenFactories], fetchCalls: boundary.defaultFetchCalls }),
  recordFetch: () => {
    boundary.defaultFetchCalls++;
    throw new Error('Forbidden network in default literal callback fixture');
  },
};
const actualGuard = process.env.BUBALY_ADAPTER_PHASE
  ? (globalThis as unknown as Record<symbol, ActualGuard>)[Symbol.for('bubaly.callback.guard.v1')]
  : defaultLiteralGuard;
if (!actualGuard || typeof actualGuard.snapshot !== 'function' || typeof actualGuard.recordFetch !== 'function') {
  throw new Error('Required sticky callback import/fetch guard is absent');
}
expect(boundary.forbiddenFactories).toEqual([]);
expect(boundary.defaultFetchCalls).toBe(0);
const importSnapshot = actualGuard.snapshot();
expect(importSnapshot.forbiddenImports).toEqual([]);
expect(importSnapshot.fetchCalls).toBe(0);
function assertBoundary() {
  expect(boundary.fetchCalls).toBe(0);
  expect(boundary.defaultFetchCalls).toBe(0);
  expect(boundary.forbiddenFactories).toEqual([]);
  const snapshot = actualGuard.snapshot();
  expect(snapshot.forbiddenImports).toEqual([]);
  expect(snapshot.fetchCalls).toBe(0);
}

const ORIGIN = 'https://callback.example.test';
type CallbackRequest = Parameters<(typeof import('@/app/api/google/calendar/callback/route'))['GET']>[0];
function request(query = '?code=synthetic-code&state=issued', cookie: string | null = 'issued'): CallbackRequest {
  return {
    url: `${ORIGIN}/api/google/calendar/callback${query}`,
    nextUrl: { origin: ORIGIN },
    cookies: { get: (name: string) => name === 'gcal_oauth_state' && cookie !== null ? { value: cookie } : undefined },
  } as unknown as CallbackRequest;
}
const operations = () => fake.calls.map(call => call.op);
function expectNoTokenWork() {
  expect(operations().filter(op => ['exchange', 'key', 'encode', 'merge'].includes(op))).toEqual([]);
}
async function callback(req = request()) {
  const { GET } = await import('@/app/api/google/calendar/callback/route');
  return GET(req);
}
function expectRedirect(result: Awaited<ReturnType<typeof callback>>, status: 'error' | 'connected') {
  expect(result.status).toBe(307);
  expect(result.headers.get('location')).toBe(`${ORIGIN}/dashboard/calendar?gcal=${status}`);
  expect(result.cookies.get('gcal_oauth_state')).toEqual({ value: '', path: '/api/google/calendar', maxAge: 0 });
}

beforeEach(() => {
  fake.auth = { data: { user: { id: 'session-user' } }, error: null };
  fake.authThrown = null;
  fake.key = true;
  fake.merge = { ok: true };
  fake.calls = [];
  vi.stubGlobal('fetch', () => { boundary.fetchCalls++; return actualGuard.recordFetch(); });
});
afterEach(() => {
  assertBoundary();
  vi.unstubAllGlobals();
});
afterAll(() => {
  assertBoundary();
});

describe('Google Calendar callback admits only an error-free authenticated identity', () => {
  it('stores the encoded token for the session identity and preserves existing preferences', async () => {
    const result = await callback();
    expectRedirect(result, 'connected');
    expect(operations()).toEqual(['server', 'auth', 'exchange', 'key', 'merge', 'encode']);
    expect(fake.calls.find(call => call.op === 'exchange')?.args).toEqual(['synthetic-code', `${ORIGIN}/api/google/calendar/callback`]);
    expect(fake.calls.find(call => call.op === 'encode')?.args).toEqual([{ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 123 }]);
    expect(fake.calls.find(call => call.op === 'merge')?.args).toEqual(['session-user', { existing: 'keep-me', googleCalendarToken: 'synthetic-encrypted-envelope' }]);
  });
  it('never takes the connected identity from callback state or query user identifiers', async () => {
    fake.auth.data.user = { id: 'actual-session-user' };
    expectRedirect(await callback(request('?code=synthetic-code&state=other-user&userId=foreign-user', 'other-user')), 'connected');
    expect(fake.calls.find(call => call.op === 'merge')?.args[0]).toBe('actual-session-user');
  });
  it.each([
    ['provider declined', '?error=access_denied&code=c&state=issued', 'issued'],
    ['missing code', '?state=issued', 'issued'],
    ['missing state', '?code=c', 'issued'],
    ['missing cookie', '?code=c&state=issued', null],
    ['wrong cookie', '?code=c&state=issued', 'different'],
    ['unequal length state', '?code=c&state=issued-long', 'issued'],
  ] as const)('consumes state and refuses %s before identity or token work', async (_label, query, cookie) => {
    expectRedirect(await callback(request(query, cookie)), 'error');
    expect(operations()).toEqual([]);
  });
  it.each([
    ['unknown', { name: 'AuthUnknownError', message: 'Synthetic read unavailable', __isAuthError: true }],
    ['known transient', { name: 'AuthRetryableFetchError', message: 'Synthetic unavailable', status: 503, __isAuthError: true }],
    ['definitive rejection', { name: 'AuthApiError', message: 'Synthetic rejection', status: 401, code: 'bad_jwt', __isAuthError: true }],
    ['plain returned error', { message: 'Synthetic identity read failed' }],
  ] as const)('refuses returned %s even with a contradictory user record', async (_label, error) => {
    fake.auth.error = error;
    expectRedirect(await callback(), 'error');
    expect(operations()).toEqual(['server', 'auth']);
    expectNoTokenWork();
  });
  it.each([
    ['no error', null],
    ['unknown error', { name: 'AuthUnknownError', message: 'Synthetic read unavailable', __isAuthError: true }],
    ['rejection', { status: 401, code: 'bad_jwt', message: 'Synthetic rejection' }],
  ] as const)('refuses an absent user with %s before token work', async (_label, error) => {
    fake.auth = { data: { user: null }, error };
    expectRedirect(await callback(), 'error');
    expect(operations()).toEqual(['server', 'auth']);
    expectNoTokenWork();
  });
  it('consumes state and refuses a thrown literal identity-read error before token work', async () => {
    fake.authThrown = { message: 'Synthetic thrown identity-read refusal' };
    expectRedirect(await callback(), 'error');
    expect(operations()).toEqual(['server', 'auth']);
    expectNoTokenWork();
  });
  it('refuses missing encryption configuration before encoding or preference merge', async () => {
    fake.key = false;
    expectRedirect(await callback(), 'error');
    expect(operations()).toEqual(['server', 'auth', 'exchange', 'key']);
  });
  it.each(['read_failed', 'write_failed', 'contended'])('returns an error redirect for a %s preference merge', async reason => {
    fake.merge = { ok: false, reason, error: { message: 'Synthetic preference refusal' } };
    expectRedirect(await callback(), 'error');
    expect(operations()).toEqual(['server', 'auth', 'exchange', 'key', 'merge', 'encode']);
    expect(fake.calls.filter(call => call.op === 'merge')).toHaveLength(1);
  });
});
