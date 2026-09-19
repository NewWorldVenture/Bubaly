import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ exchange: vi.fn(), ambient: vi.fn(), apply: vi.fn(), gate: Promise.resolve(), failed: false }));
const client = () => ({ auth: {
  exchangeCodeForSession: seam.exchange,
  getUser: async () => { await seam.gate; return { data: { user: { id: 'older-user', email: 'older@example.invalid' } }, error: null }; },
}, rpc: async () => ({ data: false, error: null }), from: () => {
  const query = { select: () => query, eq: () => query, then: (resolve: (value: unknown) => void) => resolve({ data: [{ role: 'parent' }], error: null }) };
  return query;
} });
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.ambient, createServiceClient: vi.fn() }));
vi.mock('@/lib/auth/recovery-cookies', () => ({
  createPkceCookieExchange: async () => ({ client: client(), applyTo: seam.apply, dispose: async () => {} }),
  createRecoveryCookieExchange: async () => ({ client: client(), applyTo: seam.apply, dispose: async () => {} }),
}));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
import { GET } from '@/app/auth/callback/route';

beforeEach(() => {
  vi.clearAllMocks(); seam.gate = Promise.resolve(); seam.failed = false;
  seam.exchange.mockImplementation(async () => { await seam.gate; return { error: seam.failed ? { status: 400 } : null }; });
  seam.ambient.mockImplementation(async () => client());
  seam.apply.mockImplementation((response: { cookies: { set: (name: string, value: string) => void } }) => response.cookies.set('sb-fixture-auth-token', 'older-session'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('callback admission never owns browser authentication storage', () => {
  it.each([false, true])('a delayed old callback remains cookie-neutral after a newer browser decision (exchangeFailure=%s)', async failed => {
    seam.failed = failed;
    let release = () => {};
    seam.gate = new Promise<void>(resolve => { release = resolve; });
    const pending = GET(new Request('https://app.example.invalid/auth/callback?code=older-code&next=%2Fdashboard%2Fmeals'));
    // The browser can log out or adopt another session while the older request
    // is in flight. Its response must have no mechanism to overwrite that state.
    await Promise.resolve(); release();
    const response = await pending;
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.cookies.getAll()).toEqual([]);
    expect(seam.exchange).not.toHaveBeenCalled(); expect(seam.ambient).not.toHaveBeenCalled();
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/auth/complete');
    expect(location.searchParams.get('code')).toBe('older-code');
    expect(location.searchParams.get('next')).toBe('/dashboard/meals');
  });
  it.each(['', '?error=access_denied', '?code=', '?code=one&code=two', '?code=one&error=denied', '?code=' + 'x'.repeat(4097)])('invalid or absent admission %s never refreshes ambient storage', async query => {
    const response = await GET(new Request(`https://app.example.invalid/auth/callback${query}`, { headers: { cookie: 'sb-fixture-auth-token=existing; bubaly-recovery-handoff=old' } }));
    expect(response.cookies.getAll()).toEqual([]); expect(response.headers.get('set-cookie')).toBeNull();
    expect(seam.exchange).not.toHaveBeenCalled(); expect(seam.ambient).not.toHaveBeenCalled();
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/auth/complete'); expect(location.searchParams.has('code')).toBe(false);
    expect(location.searchParams.get('error')).toBe('auth');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
