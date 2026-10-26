import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AppLockRecord } from '@/lib/security/app-lock-store';

const state = vi.hoisted(() => ({ record: null as AppLockRecord | null, unavailable: false, token: '', authError: null as Error | null }));
const USER = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-000000000051';
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: {
  getUser: async () => ({ data: { user: state.authError ? null : { id: USER } }, error: state.authError }),
  getSession: async () => ({ data: { session: { access_token: state.token } }, error: null }),
} }) }));
vi.mock('@/lib/security/app-lock-store', () => ({ readAppLockRecord: async () => state.unavailable
  ? { ok: false, error: new Error('unavailable') } : { ok: true, record: state.record } }));
const { middleware } = await import('@/middleware');
const { APP_UNLOCK_COOKIE, sealAppUnlock } = await import('@/lib/security/app-lock-server');

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('INTERNAL_SECRET', 'test-private-signer');
  state.record = { userId: USER, revision: '00000000-0000-4000-8000-000000000099', config: { enabled: true, salt: 'a'.repeat(32), hash: 'b'.repeat(64) } };
  state.unavailable = false;
  state.authError = null;
  state.token = `header.${Buffer.from(JSON.stringify({ sub: USER, session_id: SESSION })).toString('base64url')}.verified-by-auth`;
});

afterEach(() => vi.unstubAllEnvs());

const request = (path: string, options: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) => middleware(new NextRequest(`https://bubaly.example${path}`, {
  method: options.method ?? 'GET', headers: { ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
}));
const location = (response: Response) => new URL(response.headers.get('location')!);

describe('App Lock is checked before Next selects a protected page or RSC subtree', () => {
  it.each<Record<string, string>>([{}, { rsc: '1' }, { rsc: '1', 'next-router-prefetch': '1', 'next-router-state-tree': '["",{}]' }])('withholds locked page requests with headers %j', async headers => {
    const response = await request('/dashboard?view=private', { headers });
    expect(response.status).toBe(307);
    expect(location(response).pathname).toBe('/app-lock');
    expect(location(response).searchParams.get('next')).toBe('/dashboard?view=private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('does not replay a protected POST at the unlock route', async () => {
    const response = await request('/settings', { method: 'POST', headers: { 'next-action': 'private-action' } });
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe('/app-lock');
  });
  it('keeps the standalone unlock action reachable', async () => {
    expect((await request('/app-lock', { method: 'POST', headers: { 'next-action': 'unlock-action' } })).status).toBe(200);
  });
  it('allows a current session-bound unlock and forbids caching the private page', async () => {
    const cookie = sealAppUnlock(USER, state.record!, SESSION)!;
    const response = await request('/dashboard', { cookie: `${APP_UNLOCK_COOKIE}=${cookie}`, headers: { rsc: '1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects a proof from another login session', async () => {
    const cookie = sealAppUnlock(USER, state.record!, 'different-session')!;
    expect((await request('/dashboard', { cookie: `${APP_UNLOCK_COOKIE}=${cookie}` })).status).toBe(307);
  });
  it('keeps API and public page authorization unchanged', async () => {
    expect((await request('/api/calendar/occurrences')).status).toBe(200);
    expect((await request('/pricing')).status).toBe(200);
  });
  it('allows an absent private lock, but never mistakes unavailable storage for absence', async () => {
    state.record = null;
    expect((await request('/home')).status).toBe(200);
    state.unavailable = true;
    expect(location(await request('/home')).pathname).toBe('/app-lock');
  });
  it('preserves login cookies during an auth outage while withholding the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.authError = Object.assign(new Error('offline'), { name: 'AuthRetryableFetchError' });
    const response = await request('/home', { cookie: 'sb-example-auth-token=existing-session' });
    expect(location(response).pathname).toBe('/app-lock');
    expect(response.cookies.getAll().filter(cookie => cookie.maxAge === 0)).toEqual([]);
    vi.restoreAllMocks();
  });
});
