import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ exchange: vi.fn(), user: vi.fn(), factory: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.factory, createServiceClient: vi.fn() }));
vi.mock('@/lib/auth/recovery-cookies', () => ({ createRecoveryCookieExchange: async () => ({ client: await seam.factory(), applyTo: vi.fn(), dispose: vi.fn() }) }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'https://recovery-callback.supabase.co';
const USER = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-09-12T20:00:00Z');
const COOKIE = 'bubaly-recovery-handoff';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'callback-fixture', alg: 'ES256', use: 'sig' };
function token(fields: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: `${ORIGIN}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: USER,
    session_id: SID, iat: NOW / 1000, exp: NOW / 1000 + 3600, amr: [{ method: 'recovery', timestamp: NOW / 1000 }], ...fields })).toString('base64url');
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const fetcher = vi.fn<typeof fetch>();
let accessToken: string;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-private-signing-key');
  vi.stubEnv('NODE_ENV', 'production');
  accessToken = token();
  seam.exchange.mockReset().mockImplementation(async () => ({ data: { session: { access_token: accessToken } }, error: null }));
  seam.user.mockReset().mockResolvedValue({ data: { user: { id: USER, email: 'ambient@example.invalid' } }, error: null });
  seam.rpc.mockReset().mockResolvedValue({ data: false, error: null });
  seam.factory.mockReset().mockResolvedValue({ auth: { exchangeCodeForSession: seam.exchange, getUser: seam.user }, rpc: seam.rpc,
    from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [{ family_id: USER, role: 'parent' }], error: null }) }) }) }) });
  fetcher.mockReset().mockImplementation(async (raw, init = {}) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw));
    expect(url.origin).toBe(ORIGIN);
    expect(init.redirect).toBe('manual');
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.pathname === '/auth/v1/user') return Response.json({ id: USER, email: 'verified@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    throw new Error('Unexpected synthetic provider endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function callback(query = '?code=explicit-code&next=%2Fauth%2Frecovery') {
  return GET(new Request(`https://app.example.invalid/auth/callback${query}`, { headers: { cookie: 'sb-fixture-auth-token=ambient-session; bubaly-recovery-handoff=older-grant' } }));
}
function expectInvalid(response: Awaited<ReturnType<typeof GET>>) {
  expect(response.headers.get('location')).toBe('https://app.example.invalid/auth/recovery?error=invalid');
  expect(response.cookies.get(COOKIE)?.value).toBe('');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(seam.user).not.toHaveBeenCalled();
  expect(seam.rpc).not.toHaveBeenCalled();
}

describe('actual recovery callback and signed grant through installed verification SDK', () => {
  it('pins the exchanged token to a verified grant, HttpOnly cookie and matching hash handoff', async () => {
    const response = await callback();
    const grant = response.cookies.get(COOKIE)?.value;
    expect(grant).toBeTruthy();
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/auth/recovery');
    expect(location.searchParams.get('handoff')).toBe(createHash('sha256').update(grant!).digest('hex'));
    expect(response.cookies.get(COOKIE)).toMatchObject({ httpOnly: true, secure: true, path: '/auth', sameSite: 'lax', maxAge: 300 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(location.href).not.toContain(accessToken); expect(location.href).not.toContain(grant!);
    expect(seam.exchange).toHaveBeenCalledExactlyOnceWith('explicit-code');
    expect(seam.user).not.toHaveBeenCalled(); expect(seam.rpc).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([raw]) => String(raw).endsWith('/auth/v1/user'))).toBe(true);
  });
  it('bounds a near-expiry grant cookie by its actual remaining lifetime', async () => {
    accessToken = token({ amr: [{ method: 'recovery', timestamp: NOW / 1000 - 895 }] });
    expect((await callback()).cookies.get(COOKIE)?.maxAge).toBe(5);
  });
  it('allows a non-secure cookie only in the local development runtime', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await callback()).cookies.get(COOKIE)?.secure).toBe(false);
  });
  it.each(['', '?next=%2Fauth%2Frecovery', '?next=%2Fauth%2Frecovery&code=', '?next=%2Fauth%2Frecovery&error=access_denied'])('rejects missing recovery code without ambient fallback: %s', async query => {
    if (!query) query = '?next=%2Fauth%2Frecovery&code=&error=expired';
    expectInvalid(await callback(query));
    expect(seam.exchange).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['?next=%2Fauth%2Frecovery&code=one&code=two', '?next=%2Fauth%2Frecovery&code=one&error=access_denied'])('rejects conflicting explicit code evidence: %s', async query => {
    expectInvalid(await callback(query));
    expect(seam.exchange).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['returned-error', 'exchange-throw', 'factory-throw', 'missing-session', 'missing-token'])('contains %s without using an existing signed-in user', async mode => {
    if (mode === 'returned-error') seam.exchange.mockResolvedValue({ data: { session: { access_token: accessToken } }, error: { message: 'private provider diagnostic' } });
    if (mode === 'exchange-throw') seam.exchange.mockRejectedValue(new Error('private provider diagnostic'));
    if (mode === 'factory-throw') seam.factory.mockRejectedValue(new Error('private factory diagnostic'));
    if (mode === 'missing-session') seam.exchange.mockResolvedValue({ data: { session: null }, error: null });
    if (mode === 'missing-token') seam.exchange.mockResolvedValue({ data: { session: {} }, error: null });
    expectInvalid(await callback());
    expect(fetcher).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each([
    { amr: [{ method: 'password', timestamp: NOW / 1000 }] },
    { exp: NOW / 1000 - 1 },
    { amr: [{ method: 'recovery', timestamp: NOW / 1000 - 901 }] },
    { session_id: 'malformed-session' },
    { iss: 'https://wrong-project.invalid/auth/v1' },
  ])('rejects actual signed but invalid recovery evidence %j', async fields => {
    accessToken = token(fields);
    expectInvalid(await callback());
  });
  it('contains a verification provider outage without exposing token or raw errors', async () => {
    fetcher.mockRejectedValue(new Error('private provider diagnostic'));
    expectInvalid(await callback());
    expect(console.error).not.toHaveBeenCalled();
  });
  it('rejects a tampered JWT signature rather than trusting decoded recovery claims', async () => {
    const [header, body, signature] = accessToken.split('.');
    const changed = Buffer.from(signature, 'base64url'); changed[0] ^= 1;
    accessToken = `${header}.${body}.${changed.toString('base64url')}`;
    expectInvalid(await callback());
  });
  it('keeps an ordinary failed sign-in callback on its existing signed-in destination', async () => {
    seam.exchange.mockResolvedValue({ error: { message: 'ordinary failed sign-in' } });
    const response = await callback('?code=old&next=%2Fdashboard%2Fcalendar');
    expect(response.headers.get('location')).toBe('https://app.example.invalid/dashboard/calendar');
    expect(seam.user).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
    expect(response.cookies.get(COOKIE)).toBeUndefined();
  });
  it('does not broaden the special branch to a non-exact recovery destination', async () => {
    const response = await callback('?code=ordinary&next=%2Fauth%2Frecovery%3Fx%3D1');
    expect(response.headers.get('location')).toBe('https://app.example.invalid/auth/recovery?x=1');
    expect(seam.user).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
    expect(response.cookies.get(COOKIE)).toBeUndefined();
  });
});
