import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createChunks, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ getAll: vi.fn(), get: vi.fn(), set: vi.fn(), server: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: boundary.getAll, get: boundary.get, set: boundary.set }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: boundary.server, createServiceClient: vi.fn() }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { createRecoveryGrant, RECOVERY_HANDOFF_COOKIE } from '@/lib/auth/recovery-server';
import { consumeRecoveryAction, inspectRecoveryAction, saveRecoveryAction } from '@/app/(auth)/auth/recovery/actions';
import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'https://recovery-cookie-execution.supabase.co';
const COOKIE = 'sb-recovery-cookie-execution-auth-token';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-09-12T20:00:00Z');
const SECOND = NOW / 1000;
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'cookie-execution', alg: 'ES256', use: 'sig' };
type Fields = Record<string, unknown>;
function token(fields: Fields = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: `${ORIGIN}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: A,
    session_id: SID, iat: SECOND, exp: SECOND + 3600, amr: [{ method: 'recovery', timestamp: SECOND }], ...fields })).toString('base64url');
  return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
function user(id = A) { return { id, email: id === A ? 'a@example.invalid' : 'b@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }; }
function session(accessToken: string, extra: Fields = {}) {
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
  return { access_token: accessToken, refresh_token: `synthetic-refresh-${claims.sub}`, expires_at: claims.exp,
    expires_in: claims.exp - SECOND, token_type: 'bearer', user: user(claims.sub), ...extra };
}
const encode = (value: unknown) => `base64-${stringToBase64URL(JSON.stringify(value))}`;
type Call = { url: URL; method: string; headers: Headers; body: Fields | null };
let jar: Map<string, string>;
let calls: Call[];
let exchanged: ReturnType<typeof session>;
let override: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
const provider = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-grant-signing-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.invalid');
  vi.stubEnv('NODE_ENV', 'production');
  jar = new Map(); calls = []; exchanged = session(token()); override = undefined;
  boundary.getAll.mockReset().mockImplementation(() => [...jar].map(([name, value]) => ({ name, value })));
  boundary.get.mockReset().mockImplementation(name => jar.has(name) ? { name, value: jar.get(name) } : undefined);
  boundary.set.mockReset();
  boundary.server.mockReset().mockImplementation(() => { throw new Error('Recovery must not create a publishing server client'); });
  provider.mockReset().mockImplementation(async (raw, init = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    expect(url.origin).toBe(ORIGIN);
    const call = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    const result = override?.(call); if (result) return result;
    if (url.pathname.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.pathname === '/auth/v1/token') {
      expect(url.search).toBe('?grant_type=pkce');
      expect(call.body).toEqual({ auth_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
      return Response.json(exchanged);
    }
    if (url.pathname === '/auth/v1/user') {
      const bearer = call.headers.get('authorization')!.slice(7);
      const claims = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString());
      return Response.json(user(claims.sub));
    }
    throw new Error('Unexpected synthetic provider endpoint');
  });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => {
  expect(boundary.server).not.toHaveBeenCalled();
  expect(boundary.set).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
function setSession(value: ReturnType<typeof session>, chunkSize?: number) {
  jar = new Map(createChunks(COOKIE, encode(value), chunkSize).map(cookie => [cookie.name, cookie.value]));
}
function withVerifier() { jar.set(`${COOKIE}-code-verifier`, encode('synthetic-verifier/recovery')); }
function callback() { return GET(new Request('https://app.example.invalid/auth/callback?next=%2Fauth%2Frecovery&code=synthetic-code')); }
function applyResponse(response: Awaited<ReturnType<typeof GET>>, browser = jar) {
  for (const cookie of response.cookies.getAll()) {
    if (cookie.maxAge === 0) browser.delete(cookie.name); else browser.set(cookie.name, cookie.value);
  }
}
function owner(browser = jar) {
  const encoded = browser.get(COOKIE) ?? [...browser].filter(([name]) => name.startsWith(`${COOKIE}.`))
    .sort(([left], [right]) => Number(left.split('.').at(-1)) - Number(right.split('.').at(-1))).map(([, value]) => value).join('');
  return JSON.parse(stringFromBase64URL(encoded.slice(7))).user.id;
}
const tokenCalls = () => calls.filter(call => call.url.pathname === '/auth/v1/token');
const puts = () => calls.filter(call => call.method === 'PUT');

describe('actual recovery action, signed verifier and installed cookie format', () => {
  it('holds a near-expiry A write without queuing cookies that overwrite a later browser B', async () => {
    const access = token({ exp: SECOND + 20 });
    const { grant } = await createRecoveryGrant(access);
    setSession(session(access));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    override = call => call.method === 'PUT' ? held.then(() => Response.json(user())) : undefined;
    const pending = saveRecoveryAction(grant, 'Synthetic password 123');
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    const browserB = new Map([[COOKIE, encode(session(token({ sub: B })))]]);
    release();
    expect(await pending).toEqual({ outcome: 'updated' });
    expect(puts()[0].headers.get('authorization')).toBe(`Bearer ${access}`);
    expect(tokenCalls()).toHaveLength(0);
    expect(boundary.set).not.toHaveBeenCalled();
    expect(owner(browserB)).toBe(B);
  });
  it.each([undefined, 800])('reads a complete SDK cookie (chunkSize=%s) for inspect and handoff without refresh', async chunkSize => {
    const access = token(); const { grant, identity } = await createRecoveryGrant(access);
    setSession(session(access), chunkSize); jar.set(RECOVERY_HANDOFF_COOKIE, grant);
    expect(await inspectRecoveryAction(grant)).toEqual({ ok: true, identity });
    expect(await consumeRecoveryAction(createHash('sha256').update(grant).digest('hex'))).toEqual({ ok: true, identity, grant });
    expect(tokenCalls()).toHaveLength(0); expect(puts()).toHaveLength(0);
  });
  it('rejects an expired exact access token without refreshing or deleting its cookie', async () => {
    const { grant } = await createRecoveryGrant(token());
    setSession(session(token({ exp: SECOND - 1 })));
    const before = [...jar]; calls = [];
    expect(await saveRecoveryAction(grant, 'Synthetic password 123')).toEqual({ outcome: 'failed', errorKey: 'authRecovery.expiredLink' });
    expect(calls).toEqual([]); expect([...jar]).toEqual(before);
  });
  it('rejects B against A’s grant without password mutation or cookie changes', async () => {
    const { grant } = await createRecoveryGrant(token());
    setSession(session(token({ sub: B })));
    expect(await saveRecoveryAction(grant, 'Synthetic password 123')).toEqual({ outcome: 'failed', errorKey: 'authRecovery.sessionChanged' });
    expect(puts()).toHaveLength(0); expect(tokenCalls()).toHaveLength(0); expect(owner()).toBe(B);
  });
});

describe('actual callback exchange stages installed SDK cookies until verification', () => {
  it('keeps B when A exchange succeeds but required verification fails', async () => {
    setSession(session(token({ sub: B }))); withVerifier(); const before = [...jar];
    override = call => call.url.pathname === '/auth/v1/user' ? Response.json({ message: 'Synthetic outage' }, { status: 503 }) : undefined;
    const response = await callback();
    expect(response.headers.get('location')).toBe('https://app.example.invalid/auth/recovery?error=invalid');
    expect(response.cookies.getAll().map(cookie => cookie.name)).toEqual([RECOVERY_HANDOFF_COOKIE]);
    applyResponse(response); expect([...jar]).toEqual(before); expect(owner()).toBe(B);
    expect(tokenCalls()).toHaveLength(1);
  });
  it('does not expose the expired ambient B session to SDK constructor refresh', async () => {
    setSession(session(token({ sub: B, exp: SECOND - 1 }))); withVerifier();
    const response = await callback();
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0].url.search).toBe('?grant_type=pkce');
    expect(owner()).toBe(B);
    applyResponse(response); expect(owner()).toBe(A);
  });
  it('publishes verified A and durable chunk cleanup, then consumes the matching handoff', async () => {
    setSession(session(token({ sub: B }), { user: { ...user(B), user_metadata: { padding: 'x'.repeat(8000) } } }), 1000);
    const originalChunks = [...jar.keys()]; withVerifier();
    const response = await callback();
    expect(owner()).toBe(B);
    expect(response.cookies.get(COOKIE)).toMatchObject({ path: '/', sameSite: 'lax', secure: true, maxAge: 34_560_000 });
    for (const name of originalChunks) expect(response.cookies.get(name)?.maxAge).toBe(0);
    expect(response.cookies.get(`${COOKIE}-code-verifier`)?.maxAge).toBe(0);
    applyResponse(response); expect(owner()).toBe(A);
    const handoff = new URL(response.headers.get('location')!).searchParams.get('handoff')!;
    expect(await consumeRecoveryAction(handoff)).toMatchObject({ ok: true, identity: { userId: A, sessionId: SID } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it.each([400, 503])('keeps the verifier and B after failed PKCE exchange %s so a fresh request can retry', async status => {
    setSession(session(token({ sub: B }))); withVerifier(); const before = [...jar];
    override = call => call.url.pathname === '/auth/v1/token' ? Response.json({ code: 'synthetic_failure' }, { status }) : undefined;
    const failed = await callback(); applyResponse(failed);
    expect([...jar]).toEqual(before); expect(owner()).toBe(B);
    expect(failed.headers.get('location')).toContain('error=invalid');
    override = undefined;
    const retried = await callback(); applyResponse(retried);
    expect(owner()).toBe(A); expect(tokenCalls()).toHaveLength(2);
  });
  it('discards exchanged cookies when the returned token lacks verified recovery evidence', async () => {
    setSession(session(token({ sub: B }))); withVerifier();
    exchanged = session(token({ amr: [{ method: 'password', timestamp: SECOND }] }));
    const response = await callback(); applyResponse(response);
    expect(response.headers.get('location')).toContain('error=invalid');
    expect(owner()).toBe(B); expect(response.cookies.get(COOKIE)).toBeUndefined();
  });
});
