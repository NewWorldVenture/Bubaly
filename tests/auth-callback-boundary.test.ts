import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), membership: vi.fn(), exchange: vi.fn(), stored: vi.fn(), dispose: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => { throw new Error('Ambient publishing client is forbidden'); },
  createServiceClient: () => { throw new Error('Unexpected service client'); },
}));
vi.mock('@/lib/constants/super-admins', () => ({ isSuperAdminEmail: () => false }));
vi.mock('@/lib/auth/recovery-cookies', () => ({ createPkceCookieExchange: async () => ({
  origin: 'https://callback-boundary.supabase.co', anonymousId: null, dispose: backend.dispose,
  client: { auth: { exchangeCodeForSession: backend.exchange, getSession: backend.stored, getUser: backend.user }, rpc: () => {
        const query = { retry: () => query, abortSignal: () => query,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => backend.admin().then(resolve, reject) };
        return query;
      },
    from: () => {
      const query = { select: () => query, eq: () => query, retry: () => query, abortSignal: () => query,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => backend.membership().then(resolve, reject) };
      return query;
    },
  },
}) }));
import { completeCallback } from '@/lib/auth/callback-server';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { code: 'synthetic-code', next: '/home', verifierFingerprint: 'a'.repeat(64), attempt: 'e'.repeat(32) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://callback-boundary.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live transport'); }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    iss: 'https://callback-boundary.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated', exp })).toString('base64url');
  const session = { access_token: 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.synthetic', refresh_token: 'synthetic-refresh',
    token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: userId, email: 'fixture@example.invalid' } };
  backend.exchange.mockResolvedValue({ data: { session }, error: null });
  backend.stored.mockResolvedValue({ data: { session }, error: null });
  backend.user.mockResolvedValue({ data: { user: session.user }, error: null });
  backend.admin.mockResolvedValue({ data: false, error: null });
  backend.membership.mockResolvedValue({ data: [{ role: 'parent' }], error: null });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(backend.dispose).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('isolated callback completion routing boundary', () => {
  it.each([null, { status: 401 }])('returns no tokens when the provider cannot establish a user (%j)', async error => {
    backend.user.mockResolvedValue({ data: { user: null }, error });
    const result = await completeCallback(input);
    expect(result.status).toBe('rejected');
    expect(result).not.toHaveProperty('tokens');
    expect(backend.admin).not.toHaveBeenCalled(); expect(backend.membership).not.toHaveBeenCalled();
  });
  it('keeps a transiently unreadable exchange receipt on the ordinary destination without inferring admin authority', async () => {
    backend.user.mockResolvedValue({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    const result = await completeCallback(input);
    expect(result).toMatchObject({ status: 'exchanged', destination: '/home', tokens: { refresh_token: 'synthetic-refresh' } });
    expect(backend.admin).not.toHaveBeenCalled(); expect(backend.membership).not.toHaveBeenCalled();
  });
  it.each([null, []])('a failed membership read never becomes new-account onboarding (%j)', async data => {
    backend.membership.mockResolvedValue({ data, error: { message: 'Unavailable' } });
    const result = await completeCallback(input);
    expect(result).toMatchObject({ status: 'exchanged', destination: '/home' });
  });
  it('does not infer administrator status from data returned beside a failed admin read', async () => {
    backend.admin.mockResolvedValue({ data: true, error: { message: 'Unavailable' } });
    backend.membership.mockResolvedValue({ data: [{ role: 'guest' }], error: null });
    expect(await completeCallback(input)).toMatchObject({ status: 'exchanged', destination: '/dashboard/grandparent-portal' });
  });
  it('retains a verified database administrator destination', async () => {
    backend.admin.mockResolvedValue({ data: true, error: null });
    expect(await completeCallback(input)).toMatchObject({ status: 'exchanged', destination: '/admin' });
    expect(backend.membership).not.toHaveBeenCalled();
  });
  it.each(['admin', 'membership'] as const)('a raw %s read rejection preserves the verified receipt', async phase => {
    backend[phase].mockRejectedValueOnce(new TypeError('Synthetic transport interruption'));
    expect(await completeCallback(input)).toMatchObject({ status: 'exchanged', destination: '/home' });
  });
});
