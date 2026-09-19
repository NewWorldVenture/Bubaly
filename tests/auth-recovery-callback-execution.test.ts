import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ exchange: vi.fn(), user: vi.fn(), factory: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.factory, createServiceClient: vi.fn() }));
vi.mock('@/lib/auth/recovery-cookies', () => ({
  createPkceCookieExchange: async () => ({ client: await seam.factory(), origin: ORIGIN, anonymousId: null, dispose: vi.fn() }),
}));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { completeCallbackAction } from '@/app/(auth)/auth/complete/actions';

const ORIGIN = 'https://recovery-callback.supabase.co';
const USER = '11111111-1111-4111-8111-111111111111';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-09-12T20:00:00Z');

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
function session() { return { access_token: accessToken, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: NOW / 1000 + 3600, user: { id: USER } }; }
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-private-signing-key');
  vi.stubEnv('NODE_ENV', 'production');
  accessToken = token();
  seam.exchange.mockReset().mockImplementation(async () => ({ data: { session: session() }, error: null }));
  seam.user.mockReset().mockResolvedValue({ data: { user: { id: USER, email: 'ambient@example.invalid' } }, error: null });
  seam.rpc.mockReset().mockResolvedValue({ data: false, error: null });
  seam.factory.mockReset().mockResolvedValue({ auth: { exchangeCodeForSession: seam.exchange, getUser: seam.user, getSession: async () => ({ data: { session: session() }, error: null }) }, rpc: seam.rpc,
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
async function callback(next = '/auth/recovery') {
  return completeCallbackAction({ code: 'explicit-code', next, verifierFingerprint: 'a'.repeat(64) });
}
function expectInvalid(receipt: Awaited<ReturnType<typeof callback>>) {
  expect(receipt.status).not.toBe('exchanged'); expect(receipt).not.toHaveProperty('tokens'); expect(receipt).not.toHaveProperty('recovery');
  expect(seam.user).not.toHaveBeenCalled(); expect(seam.rpc).not.toHaveBeenCalled();
}

describe('recovery completion returns a signed grant without publishing cookies', () => {
  it('pins the exchanged token to a verified recovery grant and identity receipt', async () => {
    const receipt = await callback();
    expect(receipt).toMatchObject({ status: 'exchanged', destination: '/auth/recovery', tokens: { access_token: accessToken, refresh_token: 'synthetic-refresh' },
      recovery: { identity: { userId: USER, sessionId: SID, email: 'verified@example.invalid' } } });
    if (receipt.status !== 'exchanged') throw new Error('Expected checked receipt');
    expect(receipt.recovery?.grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(receipt.destination).not.toContain(accessToken); expect(receipt.destination).not.toContain(receipt.recovery!.grant);
    expect(seam.exchange).toHaveBeenCalledExactlyOnceWith('explicit-code');
    expect(seam.user).not.toHaveBeenCalled(); expect(seam.rpc).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([raw]) => String(raw).endsWith('/auth/v1/user'))).toBe(true);
  });
  it('bounds a near-expiry recovery grant by the actual evidence lifetime', async () => {
    accessToken = token({ amr: [{ method: 'recovery', timestamp: NOW / 1000 - 895 }] });
    const receipt = await callback();
    expect(receipt).toMatchObject({ status: 'exchanged', recovery: { identity: { expiresAt: NOW + 5000 } } });
  });
  it.each(['returned-error', 'exchange-throw', 'factory-throw', 'missing-session', 'missing-token'])('contains %s without ambient fallback', async mode => {
    if (mode === 'returned-error') seam.exchange.mockResolvedValue({ data: { session: session() }, error: { message: 'private provider diagnostic' } });
    if (mode === 'exchange-throw') seam.exchange.mockRejectedValue(new Error('private provider diagnostic'));
    if (mode === 'factory-throw') seam.factory.mockRejectedValue(new Error('private factory diagnostic'));
    if (mode === 'missing-session') seam.exchange.mockResolvedValue({ data: { session: null }, error: null });
    if (mode === 'missing-token') seam.exchange.mockResolvedValue({ data: { session: {} }, error: null });
    expectInvalid(await callback()); expect(fetcher).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
  });
  it.each([
    { amr: [{ method: 'password', timestamp: NOW / 1000 }] }, { exp: NOW / 1000 - 1 },
    { amr: [{ method: 'recovery', timestamp: NOW / 1000 - 901 }] }, { session_id: 'malformed-session' },
    { iss: 'https://wrong-project.invalid/auth/v1' },
  ])('rejects signed but invalid recovery evidence %j', async fields => {
    accessToken = token(fields); expectInvalid(await callback());
  });
  it('contains verification outages without exposing tokens or provider diagnostics', async () => {
    fetcher.mockRejectedValue(new Error('private provider diagnostic'));
    expectInvalid(await callback()); expect(console.error).not.toHaveBeenCalled();
  });
  it('rejects a tampered signature rather than trusting decoded recovery claims', async () => {
    const [header, body, signature] = accessToken.split('.'); const changed = Buffer.from(signature, 'base64url'); changed[0] ^= 1;
    accessToken = `${header}.${body}.${changed.toString('base64url')}`;
    expectInvalid(await callback());
  });
  it('does not use ordinary ambient fallback when recovery exchange fails', async () => {
    seam.exchange.mockResolvedValue({ error: { message: 'failed sign-in' } });
    expectInvalid(await callback()); expect(seam.user).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not grant recovery authority to a non-exact recovery destination', async () => {
    const receipt = await callback('/auth/recovery?x=1');
    expect(receipt).toMatchObject({ status: 'exchanged', destination: '/auth/recovery?x=1' });
    expect(receipt).not.toHaveProperty('recovery'); expect(seam.user).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
});
