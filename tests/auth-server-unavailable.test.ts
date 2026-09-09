import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  serviceClient: vi.fn(),
}));

// Keep the real auth helpers, transient-error classifier and email allowlist.
// Only the request-bound backend is replaced; no network or credentials are used.
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { getUser: backend.getUser }, rpc: backend.rpc, from: backend.from }),
  createServiceClient: backend.serviceClient,
}));
// The Node test runtime does not expose React's server cache. Neither auth
// helper under test consults feature tiers, so leave that external read inert.
vi.mock('@/lib/server/feature-tiers', () => ({ getFeatureTiersByHref: vi.fn() }));

import { getUser, isSuperAdmin } from '@/lib/supabase/auth';

const user = { id: '00000000-0000-0000-0000-000000000041', email: 'member@example.test' };
const unavailable = 'Account context is temporarily unavailable.';
const temporaryFailures = [
  ['timeout response', { name: 'AuthApiError', status: 408, message: 'Request timeout' }],
  ['rate limit', { name: 'AuthApiError', status: 429, message: 'Too many requests' }],
  ['server error', { name: 'AuthApiError', status: 500, message: 'Internal error' }],
  ['unavailable gateway', { name: 'AuthApiError', status: 503, message: 'Unavailable' }],
  ['infrastructure failure', { name: 'AuthApiError', status: 507, message: 'Insufficient storage' }],
  ['SDK retryable error', { name: 'AuthRetryableFetchError', message: 'Retry later' }],
  ['network error code', { code: 'network_error', message: 'Connection interrupted' }],
  ['fetch failure', new TypeError('Failed to fetch')],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  backend.getUser.mockResolvedValue({ data: { user }, error: null });
  backend.rpc.mockResolvedValue({ data: false, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('server auth failures do not masquerade as sign-out', () => {
  it.each(temporaryFailures)('getUser surfaces %s as unavailable', async (_label, error) => {
    backend.getUser.mockResolvedValue({ data: { user: null }, error });

    await expect(getUser()).rejects.toThrow(unavailable);

    expect(backend.getUser).toHaveBeenCalledTimes(1);
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.from).not.toHaveBeenCalled();
    expect(backend.serviceClient).not.toHaveBeenCalled();
  });

  it.each(temporaryFailures)('isSuperAdmin surfaces %s before any privilege lookup', async (_label, error) => {
    backend.getUser.mockResolvedValue({ data: { user: null }, error });

    await expect(isSuperAdmin()).rejects.toThrow(unavailable);

    expect(backend.getUser).toHaveBeenCalledTimes(1);
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.from).not.toHaveBeenCalled();
    expect(backend.serviceClient).not.toHaveBeenCalled();
  });

  it('does not trust returned user data when that lookup also failed temporarily', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', user.email);
    backend.getUser.mockResolvedValue({ data: { user }, error: { status: 503 } });

    await expect(getUser()).rejects.toThrow(unavailable);
    await expect(isSuperAdmin()).rejects.toThrow(unavailable);
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it('recovers the same user and privileges on the next successful request', async () => {
    backend.getUser
      .mockResolvedValueOnce({ data: { user: null }, error: { status: 429 } })
      .mockResolvedValueOnce({ data: { user }, error: null });
    await expect(getUser()).rejects.toThrow(unavailable);
    await expect(getUser()).resolves.toBe(user);

    backend.getUser
      .mockResolvedValueOnce({ data: { user: null }, error: { status: 503 } })
      .mockResolvedValueOnce({ data: { user }, error: null });
    backend.rpc.mockResolvedValue({ data: true, error: null });
    await expect(isSuperAdmin()).rejects.toThrow(unavailable);
    await expect(isSuperAdmin()).resolves.toBe(true);
    expect(backend.rpc).toHaveBeenCalledExactlyOnceWith('is_super_admin');
  });

  it('keeps a rejected backend request unavailable instead of converting it to an anonymous visitor', async () => {
    const failure = new TypeError('Failed to fetch');
    backend.getUser.mockRejectedValue(failure);

    await expect(getUser()).rejects.toBe(failure);
    await expect(isSuperAdmin()).rejects.toBe(failure);
    expect(backend.rpc).not.toHaveBeenCalled();
  });
});

describe('definitive signed-out and verified-user outcomes', () => {
  it.each([
    ['empty session', null],
    ['missing session', { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' }],
    ['missing session code', { code: 'session_missing', status: 400 }],
    ['rejected refresh token', { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' }],
    ['revoked session', { name: 'AuthApiError', status: 401, code: 'session_not_found' }],
    ['invalid token', { name: 'AuthApiError', status: 403, code: 'bad_jwt' }],
  ] as const)('returns signed-out outcomes for %s', async (_label, error) => {
    backend.getUser.mockResolvedValue({ data: { user: null }, error });

    await expect(getUser()).resolves.toBeNull();
    await expect(isSuperAdmin()).resolves.toBe(false);
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.serviceClient).not.toHaveBeenCalled();
    if (!error || ('name' in error && error.name === 'AuthSessionMissingError') || ('code' in error && error.code === 'session_missing')) {
      expect(console.error).not.toHaveBeenCalled();
    }
  });

  it('returns the verified user without looking up family or admin data', async () => {
    await expect(getUser()).resolves.toBe(user);
    expect(backend.rpc).not.toHaveBeenCalled();
    expect(backend.from).not.toHaveBeenCalled();
  });

  it('uses the actual configured email allowlist only after a successful user lookup', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', 'MEMBER@EXAMPLE.TEST');

    await expect(isSuperAdmin()).resolves.toBe(true);
    expect(backend.getUser).toHaveBeenCalledTimes(1);
    expect(backend.rpc).not.toHaveBeenCalled();
  });

  it.each([true, false, null, 'true'])('accepts only a true database admin result (%s)', async (data) => {
    backend.rpc.mockResolvedValue({ data, error: null });

    await expect(isSuperAdmin()).resolves.toBe(data === true);
    expect(backend.rpc).toHaveBeenCalledExactlyOnceWith('is_super_admin');
  });
});
