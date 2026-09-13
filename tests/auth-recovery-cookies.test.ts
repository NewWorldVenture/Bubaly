import { createChunks, createServerClient, stringToBase64URL } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cookie = { name: string; value: string };
const state = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn(), delete: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => state }));

import { readRecoveryCookieToken } from '@/lib/auth/recovery-cookies';
import { RecoveryError } from '@/lib/auth/recovery-server';

const ORIGIN = 'https://recovery-cookie.supabase.co';
const KEY = 'sb-recovery-cookie-auth-token';
const TOKEN = 'exact-cookie-access-token';
const network = vi.fn<typeof fetch>();
let jar: Cookie[];

function encoded(value: unknown): string {
  return `base64-${stringToBase64URL(JSON.stringify(value))}`;
}
function session(accessToken = TOKEN, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: accessToken, refresh_token: 'synthetic-refresh-token', expires_at: 1, ...extra };
}
function paddedRaw(size: number): string {
  const empty = JSON.stringify(session(TOKEN, { padding: '' }));
  return JSON.stringify(session(TOKEN, { padding: 'x'.repeat(size - empty.length) }));
}
function inChunks(value: string, count: number): Cookie[] {
  // Deliberately small early chunks make the count limit independent of the size limit.
  return Array.from({ length: count }, (_, index) => ({
    name: `${KEY}.${index}`,
    value: index === count - 1 ? value.slice(index) : value[index],
  }));
}
async function expectSessionChanged(): Promise<void> {
  await expect(readRecoveryCookieToken()).rejects.toMatchObject({
    name: 'RecoveryError', key: 'authRecovery.sessionChanged', message: 'authRecovery.sessionChanged',
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key');
  jar = [];
  state.getAll.mockImplementation(() => jar.map(cookie => ({ ...cookie })));
  state.set.mockImplementation(() => { throw new Error('Recovery must not persist session cookies'); });
  state.delete.mockImplementation(() => { throw new Error('Recovery must not delete session cookies'); });
  network.mockImplementation(async () => { throw new Error('Unexpected network access while reading cookies'); });
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

describe('recovery cookie candidate compatibility without session refresh', () => {
  it.each(['base64url', 'legacy JSON'])('reads an unchunked %s session cookie', async format => {
    const value = format === 'base64url' ? encoded(session()) : JSON.stringify(session());
    jar = createChunks(KEY, value);
    expect(jar).toHaveLength(1);
    await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
    expect(state.getAll).toHaveBeenCalledTimes(1);
  });

  it.each(['base64url', 'legacy JSON'])('combines SDK-created %s chunks in numeric order', async format => {
    const data = session(TOKEN, { user: { user_metadata: { display_name: 'Zoë 家族 🌿', padding: 'x'.repeat(35_000) } } });
    jar = createChunks(KEY, format === 'base64url' ? encoded(data) : JSON.stringify(data));
    expect(jar.length).toBeGreaterThan(10);
    // Request header order need not match either numerical or lexical chunk order.
    jar.reverse();
    await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
  });

  it('ignores verifier, other-project and lookalike cookies even when malformed or duplicated', async () => {
    jar = [
      { name: 'sb-other-project-auth-token', value: encoded(session('wrong-project-token')) },
      { name: 'sb-other-project-auth-token.01', value: 'x'.repeat(65_537) },
      { name: `${KEY}-code-verifier`, value: 'not-session-json' },
      { name: `${KEY}-code-verifier`, value: 'another-verifier' },
      { name: `${KEY}-code-verifier.0`, value: '' },
      { name: `${KEY}-user`, value: 'null' },
      { name: `${KEY}-extra`, value: encoded(session('lookalike-token')) },
      { name: KEY, value: encoded(session()) },
    ];
    await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
  });

  it.each([
    { label: 'double quotes and surrounding whitespace', origin: ` \" ${ORIGIN} \" `, key: KEY },
    { label: 'single quotes and surrounding whitespace', origin: ` '${ORIGIN}/' `, key: KEY },
    { label: 'custom endpoint', origin: 'https://auth.example.invalid', key: 'sb-auth-auth-token' },
    { label: 'local host', origin: 'http://localhost:54321', key: 'sb-localhost-auth-token' },
    { label: 'IPv4 loopback', origin: 'http://127.0.0.1:54321', key: 'sb-127-auth-token' },
    { label: 'IPv6 loopback', origin: 'http://[::1]:54321', key: 'sb-[::1]-auth-token' },
  ])('uses the SDK storage key for $label', async ({ origin, key }) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    jar = [{ name: key, value: encoded(session()) }];
    await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
  });

  it.each(['not-a-jwt', 'a.b.c', ' token-with-surrounding-spaces '])('passes candidate %j unchanged to later verification', async token => {
    jar = createChunks(KEY, encoded(session(token)));
    await expect(readRecoveryCookieToken()).resolves.toBe(token);
  });

  it('reads cookies emitted by the installed SSR client at the refresh margin without refreshing or rewriting', async () => {
    const now = Date.parse('2026-09-12T20:00:00Z');
    const second = now / 1000;
    const token = [
      stringToBase64URL(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      stringToBase64URL(JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', exp: second + 3_600, iat: second })),
      stringToBase64URL('synthetic-signature'),
    ].join('.');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const provider = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe(`${ORIGIN}/auth/v1/user`);
      expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json({
        id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated',
        email: 'synthetic@example.invalid', app_metadata: {}, user_metadata: { padding: 'x'.repeat(5_000) },
        created_at: '2026-01-01T00:00:00Z',
      });
    });
    const client = createServerClient(ORIGIN, 'synthetic-public-anon', {
      global: { fetch: provider },
      cookies: {
        getAll: () => jar,
        setAll: values => {
          for (const { name, value } of values) {
            jar = jar.filter(cookie => cookie.name !== name);
            if (value) jar.push({ name, value });
          }
        },
      },
    });
    try {
      const installed = await client.auth.setSession({ access_token: token, refresh_token: 'synthetic-refresh' });
      expect(installed.error).toBeNull();
      expect(provider).toHaveBeenCalledTimes(1);
      expect(jar.length).toBeGreaterThan(1);
      expect(jar[0].name).toBe(`${KEY}.0`);
      expect(jar[0].value).toMatch(/^base64-/);
    } finally {
      await client.auth.dispose();
    }
    const cookiesBefore = structuredClone(jar);
    vi.spyOn(Date, 'now').mockReturnValue(now + 3_580_000);
    await expect(readRecoveryCookieToken()).resolves.toBe(token);
    vi.spyOn(Date, 'now').mockReturnValue(now + 3_601_000);
    await expect(readRecoveryCookieToken()).resolves.toBe(token);
    expect(jar).toEqual(cookiesBefore);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('recovery cookie ambiguity and malformed values fail closed', () => {
  it.each([
    { label: 'no cookies', cookies: [] },
    { label: 'only another project', cookies: [{ name: 'sb-other-auth-token', value: encoded(session()) }] },
    { label: 'only the verifier', cookies: [{ name: `${KEY}-code-verifier`, value: encoded(session()) }] },
    { label: 'empty base', cookies: [{ name: KEY, value: '' }] },
    { label: 'duplicate identical bases', cookies: [{ name: KEY, value: encoded(session()) }, { name: KEY, value: encoded(session()) }] },
    { label: 'duplicate conflicting bases', cookies: [{ name: KEY, value: encoded(session()) }, { name: KEY, value: encoded(session('other')) }] },
    { label: 'duplicate chunks', cookies: [{ name: `${KEY}.0`, value: encoded(session()) }, { name: `${KEY}.0`, value: encoded(session()) }] },
    { label: 'base plus chunks', cookies: [{ name: KEY, value: encoded(session()) }, { name: `${KEY}.0`, value: encoded(session()) }] },
    { label: 'empty base plus valid chunks', cookies: [{ name: KEY, value: '' }, { name: `${KEY}.0`, value: encoded(session()) }] },
    { label: 'valid base plus empty chunk', cookies: [{ name: KEY, value: encoded(session()) }, { name: `${KEY}.0`, value: '' }] },
    { label: 'missing initial chunk', cookies: [{ name: `${KEY}.1`, value: encoded(session()) }] },
    { label: 'gap after a valid first chunk', cookies: [{ name: `${KEY}.0`, value: encoded(session()) }, { name: `${KEY}.2`, value: 'ignored-tail' }] },
    { label: 'empty chunk hiding a tail', cookies: [{ name: `${KEY}.0`, value: encoded(session()) }, { name: `${KEY}.1`, value: '' }, { name: `${KEY}.2`, value: 'ignored-tail' }] },
  ])('rejects $label', async ({ cookies }) => {
    jar = cookies;
    await expectSessionChanged();
  });

  it.each(['00', '01', '-1', '+1', '1.0', '1e0', '', 'foo', '9007199254740992'])('rejects noncanonical or out-of-range chunk suffix %j', async suffix => {
    jar = [{ name: `${KEY}.0`, value: encoded(session()) }, { name: `${KEY}.${suffix}`, value: 'ignored-tail' }];
    await expectSessionChanged();
  });

  it.each([
    { label: 'invalid JSON', value: '{"access_token":' },
    { label: 'URI-encoded JSON', value: encodeURIComponent(JSON.stringify(session())) },
    { label: 'empty base64 payload', value: 'base64-' },
    { label: 'invalid base64 character', value: 'base64-*' },
    { label: 'base64 text that is not JSON', value: `base64-${stringToBase64URL('not JSON')}` },
    { label: 'padded base64', value: `${encoded(session())}=` },
    { label: 'base64 whitespace', value: `${encoded(session())}\n` },
    { label: 'extra base64 tail bits', value: `${encoded(session())}A` },
  ])('rejects $label without returning session contents', async ({ value }) => {
    jar = [{ name: KEY, value }];
    await expectSessionChanged();
  });

  it.each([
    { label: 'null', value: null }, { label: 'array', value: [session()] },
    { label: 'string', value: TOKEN }, { label: 'number', value: 1 },
    { label: 'boolean', value: true }, { label: 'missing token', value: {} },
    { label: 'empty token', value: { access_token: '' } }, { label: 'null token', value: { access_token: null } },
    { label: 'numeric token', value: { access_token: 42 } }, { label: 'array token', value: { access_token: [TOKEN] } },
    { label: 'object token', value: { access_token: { value: TOKEN } } },
    { label: 'token only in user data', value: { user: { access_token: TOKEN } } },
  ])('rejects a $label session in both supported encodings', async ({ value }) => {
    for (const serialized of [JSON.stringify(value), encoded(value)]) {
      jar = [{ name: KEY, value: serialized }];
      await expectSessionChanged();
    }
  });

  it('throws the shared RecoveryError type', async () => {
    await expect(readRecoveryCookieToken()).rejects.toBeInstanceOf(RecoveryError);
  });
});

describe('recovery cookie resource and configuration boundaries', () => {
  it.each([65_536, 65_537])('bounds combined cookie data at 65536 characters (size=%i)', async size => {
    const raw = paddedRaw(size);
    expect(raw).toHaveLength(size);
    jar = createChunks(KEY, raw);
    expect(jar.length).toBeLessThanOrEqual(24);
    if (size === 65_536) await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
    else await expectSessionChanged();
  });

  it.each([24, 25])('bounds canonical chunks at 24 (count=%i)', async count => {
    jar = inChunks(encoded(session()), count);
    expect(jar.every(cookie => cookie.value.length > 0)).toBe(true);
    if (count === 24) await expect(readRecoveryCookieToken()).resolves.toBe(TOKEN);
    else await expectSessionChanged();
  });

  it.each([16_384, 16_385])('bounds candidate access tokens at 16384 characters (size=%i)', async size => {
    const token = 't'.repeat(size);
    jar = createChunks(KEY, encoded(session(token)));
    if (size === 16_384) await expect(readRecoveryCookieToken()).resolves.toBe(token);
    else await expectSessionChanged();
  });

  it.each([
    undefined, '', '   ', 'not-a-url', 'recovery-cookie.supabase.co',
    'ftp://recovery-cookie.supabase.co', 'http://recovery-cookie.supabase.co',
    `${ORIGIN}/auth/v1`, `${ORIGIN}?query=1`, `${ORIGIN}#fragment`,
    'https://user:password@recovery-cookie.supabase.co',
  ])('reports invalid endpoint configuration as setupRequired (%j)', async origin => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    jar = [{ name: KEY, value: encoded(session()) }];
    await expect(readRecoveryCookieToken()).rejects.toMatchObject({
      name: 'RecoveryError', key: 'authRecovery.setupRequired', message: 'authRecovery.setupRequired',
    });
  });
});
