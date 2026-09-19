import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeSessionToken } from '@/lib/auth/revoke-session';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://logout-provider.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('token-specific revocation through the installed public SDK', () => {
  it.each(['local', 'global'] as const)('revokes only the captured JWT with requested %s scope and no browser credentials', async scope => {
    expect(await revokeSessionToken('synthetic-A-token', scope)).toBe('confirmed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://logout-provider.invalid/auth/v1/logout?scope=${scope}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-A-token');
    expect(headers.get('apikey')).toBe('synthetic-public-key');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(init?.keepalive).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('defaults to this device and never refreshes a token', async () => {
    await revokeSessionToken('synthetic-A-token');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://logout-provider.invalid/auth/v1/logout?scope=local']);
  });
  it.each([400, 401, 403, 404, 429, 500, 503])('does not claim revocation after HTTP %s', async status => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ message: 'Fixture refusal' }), { status, headers: { 'content-type': 'application/json' } }));
    expect(await revokeSessionToken('synthetic-A-token')).toBe('unconfirmed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('contains a failed transport without retrying', async () => {
    fetcher.mockRejectedValue(new TypeError('Fixture network failure'));
    expect(await revokeSessionToken('synthetic-A-token')).toBe('unconfirmed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns at the deadline even if transport ignores abort, with no late success claim', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = revokeSessionToken('synthetic-A-token');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toBe('unconfirmed');
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finish(new Response(null, { status: 204 }));
    await Promise.resolve();
    expect(await result).toBe('unconfirmed');
  });
  it.each(['http://provider.invalid', 'https://user:password@provider.invalid', 'https://provider.invalid/wrong', 'not a url'])('rejects invalid provider origin %s before transport', async url => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    expect(await revokeSessionToken('synthetic-A-token')).toBe('unconfirmed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not dispatch without a token or public key', async () => {
    expect(await revokeSessionToken('')).toBe('unconfirmed');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(await revokeSessionToken('synthetic-A-token')).toBe('unconfirmed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
