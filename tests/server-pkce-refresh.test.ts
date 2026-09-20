import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combineChunks, createChunks, type CookieOptions } from '@supabase/ssr';
import { NextRequest } from 'next/server';

const requestCookies = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as { name: string; value: string; options?: { maxAge?: number } }[],
}));

// Only Next's request context is supplied. The application factories, refresh
// transport, SSR cookie adapter and installed auth SDK all execute unchanged.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...requestCookies.values].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: CookieOptions) => {
      requestCookies.writes.push({ name, value, options });
      if (options?.maxAge === 0) requestCookies.values.delete(name);
      else requestCookies.values.set(name, value);
    },
  }),
}));

import { createServer } from '@/lib/supabase/server';
import { middleware } from '@/middleware';

const origin = 'https://pending-handoff.supabase.co';
const sessionKey = 'sb-pending-handoff-auth-token';
const verifierKey = `${sessionKey}-code-verifier`;
const user = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aud: 'authenticated', role: 'authenticated',
  email: 'pending-handoff@example.invalid', app_metadata: {}, user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const clients: Awaited<ReturnType<typeof createServer>>[] = [];
const requests: { path: string; authorization: string | null; body: unknown }[] = [];
let renewedSession: ReturnType<typeof session>;

function session(expired: boolean) {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const payload = Buffer.from(JSON.stringify({ sub: user.id, session_id: sessionId, exp: expires_at })).toString('base64url');
  return {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`,
    refresh_token: expired ? 'synthetic-old-refresh' : 'synthetic-rotated-refresh',
    token_type: 'bearer', expires_in: 3600, expires_at, user,
  };
}

function encoded(value: unknown) {
  return `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

const pendingCases = [
  ['signup verifier', 'synthetic-signup-verifier', false],
  ['recovery verifier and purpose suffix', 'synthetic-recovery-verifier/recovery', false],
  ['chunked signup verifier', 'synthetic-signup-verifier', true],
  ['chunked recovery verifier and purpose suffix', 'synthetic-recovery-verifier/recovery', true],
] as const;

function seed(verifier?: string, chunked = false) {
  requestCookies.values.set(sessionKey, encoded(session(true)));
  // A different project and unrelated app data must also remain untouched.
  requestCookies.values.set('sb-other-project-auth-token-code-verifier', 'unrelated-verifier');
  requestCookies.values.set('unrelated-app-cookie', 'unrelated-value');
  const pending = verifier === undefined ? [] : createChunks(verifierKey, encoded(verifier), chunked ? 23 : undefined);
  for (const { name, value } of pending) requestCookies.values.set(name, value);
  return pending;
}

async function readSession(get: (name: string) => string | undefined) {
  const value = await combineChunks(sessionKey, get);
  expect(value).toMatch(/^base64-/);
  return JSON.parse(Buffer.from(value!.slice(7), 'base64url').toString('utf8')) as ReturnType<typeof session>;
}

function assertRotated(value: ReturnType<typeof session>) {
  expect(value.user.id).toBe(user.id);
  expect(value.refresh_token).toBe('synthetic-rotated-refresh');
  const claims = JSON.parse(Buffer.from(value.access_token.split('.')[1], 'base64url').toString('utf8'));
  expect(claims).toMatchObject({ sub: user.id, session_id: sessionId });
  expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
}

function assertProviderVerification() {
  expect(requests.filter(({ path }) => path === '/auth/v1/token?grant_type=refresh_token')).toEqual([
    expect.objectContaining({ body: { refresh_token: 'synthetic-old-refresh' } }),
  ]);
  const verified = requests.filter(({ path }) => path === '/auth/v1/user');
  expect(verified).toHaveLength(1);
  expect(verified[0].authorization).toBe(`Bearer ${renewedSession.access_token}`);
}

beforeEach(() => {
  requestCookies.values.clear();
  requestCookies.writes.length = 0;
  requests.length = 0;
  renewedSession = session(false);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.invalid');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization');
    const path = `${url.pathname}${url.search}`;
    requests.push({ path, authorization, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.origin !== origin) throw new Error('Unexpected synthetic origin');
    if (path === '/auth/v1/token?grant_type=refresh_token') return Response.json(renewedSession);
    if (path === '/auth/v1/user') return Response.json(user);
    throw new Error('Unexpected synthetic provider endpoint');
  }));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.auth.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ordinary installed-SDK server refresh preserves pending PKCE handoffs', () => {
  it.each(pendingCases)('createServer retains %s while rotating the existing session', async (_label, verifier, chunked) => {
    const pending = seed(verifier, chunked);
    const client = await createServer();
    clients.push(client);
    const result = await client.auth.getUser();
    expect(result.error).toBeNull();
    expect(result.data.user?.id).toBe(user.id);
    assertProviderVerification();
    assertRotated(await readSession(name => requestCookies.values.get(name)));
    expect.soft(pending.every(({ name, value }) => requestCookies.values.get(name) === value)).toBe(true);
    expect.soft(requestCookies.writes.filter(({ name }) => name.startsWith(verifierKey))).toEqual([]);
    expect(requestCookies.values.get('sb-other-project-auth-token-code-verifier')).toBe('unrelated-verifier');
    expect(requestCookies.values.get('unrelated-app-cookie')).toBe('unrelated-value');
  });

  it.each(pendingCases)('middleware retains %s and propagates the refreshed session to request and response', async (_label, verifier, chunked) => {
    const pending = seed(verifier, chunked);
    const req = new NextRequest('https://app.example.invalid/home', {
      headers: { cookie: [...requestCookies.values].map(([name, value]) => `${name}=${value}`).join('; ') },
    });
    const response = await middleware(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    assertProviderVerification();
    const requestSession = await readSession(name => req.cookies.get(name)?.value);
    const responseSession = await readSession(name => response.cookies.get(name)?.value);
    assertRotated(requestSession);
    expect(responseSession).toEqual(requestSession);
    const forwarded = new NextRequest(req.url, { headers: { cookie: response.headers.get('x-middleware-request-cookie') ?? '' } });
    expect(await readSession(name => forwarded.cookies.get(name)?.value)).toEqual(requestSession);
    expect.soft(pending.every(({ name, value }) => req.cookies.get(name)?.value === value)).toBe(true);
    expect.soft(pending.every(({ name, value }) => forwarded.cookies.get(name)?.value === value)).toBe(true);
    expect.soft(response.cookies.getAll().filter(({ name }) => name.startsWith(verifierKey))).toEqual([]);
    expect(req.cookies.get('sb-other-project-auth-token-code-verifier')?.value).toBe('unrelated-verifier');
    expect(req.cookies.get('unrelated-app-cookie')?.value).toBe('unrelated-value');
  });

  it.each(['server', 'middleware'] as const)('%s still rotates and verifies a session without a pending handoff', async surface => {
    seed();
    if (surface === 'server') {
      const client = await createServer();
      clients.push(client);
      const result = await client.auth.getUser();
      expect(result.error).toBeNull();
      expect(result.data.user?.id).toBe(user.id);
      assertRotated(await readSession(name => requestCookies.values.get(name)));
    } else {
      const req = new NextRequest('https://app.example.invalid/home', {
        headers: { cookie: [...requestCookies.values].map(([name, value]) => `${name}=${value}`).join('; ') },
      });
      const response = await middleware(req);
      expect(response.status).toBe(200);
      assertRotated(await readSession(name => req.cookies.get(name)?.value));
      expect(await readSession(name => response.cookies.get(name)?.value)).toEqual(await readSession(name => req.cookies.get(name)?.value));
    }
    assertProviderVerification();
  });
});
