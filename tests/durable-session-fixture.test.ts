import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Cookie } from '@playwright/test';
import {
  authCookieName, authCookies, createOwnedAccount, expiredSessionCookies,
  expireStoredSession, readSession, requireLocalOrigin,
} from './e2e/helpers/durable-session';

const origin = 'http://127.0.0.1:54321';
const name = 'sb-127-auth-token';
const firstUserId = '00000000-0000-4000-8000-000000000001';
const value = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: 99_999, user: { id: 'synthetic-user' } };
const cookie = (key: string, data: string): Cookie => ({ name: key, value: data, domain: 'localhost', path: '/', expires: 99_999_999_999, httpOnly: false, secure: false, sameSite: 'Lax' });
const encoded = (data: unknown) => `base64-${Buffer.from(JSON.stringify(data)).toString('base64url')}`;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('durable-session fixture isolation', () => {
  it.each(['http://localhost:3107', origin, 'http://[::1]:54321'])('allows explicit HTTP loopback %s', (url) => {
    expect(requireLocalOrigin(url)).toBe(url);
  });

  it.each([undefined, '', 'not-a-url', 'https://production.supabase.co', 'http://localhost.evil.test', 'http://127.0.0.1@evil.test', 'http://secret@localhost', 'http://localhost/path', 'http://localhost?x=1', 'https://localhost'])('refuses unsafe origin without request even with remote override: %s', async (url) => {
    vi.stubEnv('E2E_ALLOW_REMOTE_SUPABASE', '1');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(createOwnedAccount(url ?? '', 'synthetic-service-key')).rejects.toThrow(/local|origins/);
    expect(fetch).not.toHaveBeenCalled();
  });

  function api(failTable?: string, failDelete = false) {
    const calls: Array<{ path: string; method: string; query: URLSearchParams; body: Record<string, unknown> }> = [];
    let users = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      calls.push({ path: url.pathname, method, query: url.searchParams, body });
      if (method === 'POST' && url.pathname === '/auth/v1/admin/users') {
        users++;
        return Response.json({ id: `00000000-0000-4000-8000-${String(users).padStart(12, '0')}`, email: body.email });
      }
      if ((method === 'POST' && url.pathname === `/rest/v1/${failTable}`)
        || (failDelete && method === 'DELETE' && url.pathname === '/rest/v1/families')) {
        return Response.json({ message: 'SYNTHETIC_PROVIDER_PRIVATE_DETAIL', code: 'synthetic_failure' }, { status: 500 });
      }
      if (url.pathname.startsWith('/auth/v1/admin/users/')) return Response.json({});
      return new Response(null, { status: 204 });
    }));
    return calls;
  }

  it('creates unique accounts without shared E2E credentials and deletes only owned IDs', async () => {
    vi.stubEnv('E2E_AUTH_EMAIL', 'shared@example.test');
    vi.stubEnv('E2E_AUTH_PASSWORD', 'shared-password');
    const calls = api();
    const first = await createOwnedAccount(origin, 'synthetic-service-key');
    const second = await createOwnedAccount(origin, 'synthetic-service-key');
    expect(first.email !== second.email && first.email !== process.env.E2E_AUTH_EMAIL).toBe(true);
    expect(first.password !== second.password && first.password !== process.env.E2E_AUTH_PASSWORD).toBe(true);
    expect(first.familyId !== second.familyId).toBe(true);
    await first.dispose();
    await first.dispose();
    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes[0].query.get('id') === `eq.${first.familyId}`).toBe(true);
    expect(deletes[0].query.get('created_by') === `eq.${first.userId}`).toBe(true);
    expect(deletes[1].path === `/auth/v1/admin/users/${first.userId}`).toBe(true);
    expect(calls.some((call) => call.method === 'GET')).toBe(false);
    await second.dispose();
  });

  it('cleans the account and exact household after partial setup fails without exposing provider details', async () => {
    const calls = api('family_members');
    await expect(createOwnedAccount(origin, 'synthetic-service-key')).rejects.toThrow('Durable-session E2E could not initialize its owned fixture.');
    const family = calls.find((call) => call.method === 'POST' && call.path === '/rest/v1/families')!;
    const deletion = calls.find((call) => call.method === 'DELETE' && call.path === '/rest/v1/families')!;
    expect(deletion.query.get('id') === `eq.${family.body.id}`).toBe(true);
    expect(deletion.query.get('created_by')).toBe(`eq.${firstUserId}`);
    expect(calls.some((call) => call.method === 'DELETE' && call.path === `/auth/v1/admin/users/${firstUserId}`)).toBe(true);
  });

  it('attempts account cleanup and reports a sanitized error when household deletion fails', async () => {
    const calls = api(undefined, true);
    const account = await createOwnedAccount(origin, 'synthetic-service-key');
    await expect(account.dispose()).rejects.toThrow('Durable-session E2E could not clean up its owned fixture.');
    expect(calls.some((call) => call.method === 'DELETE' && call.path === `/auth/v1/admin/users/${firstUserId}`)).toBe(true);
  });
});

describe('durable-session cookie manipulation', () => {
  it('reassembles double-digit chunks numerically and ignores other projects', () => {
    const raw = encoded({ ...value, padding: 'x'.repeat(1000) });
    const chunks = raw.match(/.{1,100}/g)!.map((part, index) => cookie(`${name}.${index}`, part)).reverse();
    chunks.push(cookie('sb-other-auth-token', 'unrelated'));
    expect(authCookieName(origin)).toBe(name);
    expect(authCookies(chunks, name).length).toBeGreaterThan(10);
    expect(readSession(chunks, name).refresh_token === value.refresh_token).toBe(true);
  });

  it.each([
    { cookies: [] },
    { cookies: [cookie(`${name}.1`, encoded(value))] },
    { cookies: [cookie(name, encoded(value)), cookie(`${name}.0`, 'tail')] },
    { cookies: [cookie(name, 'private-invalid-data')] },
  ])('rejects absent or incomplete state without echoing contents', ({ cookies }) => {
    expect(() => readSession(cookies, name)).toThrow('Durable-session E2E expected a complete stored session.');
  });

  it('expires only SDK metadata and preserves JWT, refresh token, scope and lifetime', () => {
    const original = cookie(name, encoded(value));
    const expired = expiredSessionCookies([original], name, 100_000_000);
    const session = readSession(expired, name);
    expect(session.access_token === value.access_token && session.refresh_token === value.refresh_token).toBe(true);
    expect(session.expires_at).toBe(96_400);
    expect(session.expires_in).toBe(0);
    expect(expired[0].expires).toBe(original.expires);
    expect(expired[0].sameSite).toBe('Lax');
  });

  it('preserves locale and another project cookie while replacing all auth chunks', async () => {
    let jar = [cookie(name, encoded(value)), cookie('bubaly-locale', 'de-DE'), cookie('sb-other-auth-token', 'unrelated')];
    const context = {
      cookies: async () => jar,
      clearCookies: async ({ name: removed }: { name: string }) => { jar = jar.filter((item) => item.name !== removed); },
      addCookies: async (cookies: Cookie[]) => { jar.push(...cookies); },
    } as unknown as BrowserContext;
    await expireStoredSession(context, name);
    expect(jar.some((item) => item.name === 'bubaly-locale' && item.value === 'de-DE')).toBe(true);
    expect(jar.some((item) => item.name === 'sb-other-auth-token' && item.value === 'unrelated')).toBe(true);
    expect(readSession(jar, name).expires_at < Date.now() / 1000).toBe(true);
  });
});
