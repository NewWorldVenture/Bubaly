// LIBRARY-BACDB489D3FF: a failed sign-out detach left the device enrolled.
//
// detachPushDevice() forgot the stored device key BEFORE it sent the
// unsubscribe, then called any answer success: a 401, a 429, a 500, a network
// error or its own 4 s abort. Sign-out revoked the token straight after, so a
// failed detach left the push_devices row enabled with nothing left to retry
// it, and the signed-out browser kept receiving that account's notifications.
// The path that finishes a server-side sign-out (revoke: false) skipped the
// detach altogether.
//
// Now only a 2xx counts, a server fault is tried once more, and when the
// server cannot be made to drop the row this device closes its own push
// channel instead, which needs no session at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  order: [] as string[],
  unregister: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth/browser-session-storage', () => ({
  captureBrowserSessionSnapshot: () => env.session,
  clearBrowserSessionSnapshot: () => { env.session = null; return true; },
}));
vi.mock('@/lib/auth/session-change', () => ({ notifySessionStorageChanged: () => {} }));
vi.mock('@/lib/offline/cache', () => ({ clearAllCache: () => {} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ realtime: { setAuth: async () => {} } }) }));
vi.mock('@/lib/auth/revoke-session', () => ({
  revokeSessionToken: async (token: string) => { env.order.push(`revoke:${token}`); return 'confirmed'; },
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: { unregister: env.unregister } }));

const { detachPushDevice, rememberPushDevice } = await import('@/lib/push/device-registration');
const { captureSignOutIntent, signOutBrowserSession } = await import('@/lib/auth/browser-signout');

const ENDPOINT = 'https://push.example.test/abc';
const TOKEN = 'a'.repeat(64);
const STORAGE_KEY = 'bubaly.push.device';
let store: Map<string, string>;
let subscribed: boolean;

/** This browser's own push channel. `release` is what unsubscribe() answers. */
function browser(release: () => Promise<boolean> = async () => { subscribed = false; return true; }) {
  subscribed = true;
  const subscription = { endpoint: ENDPOINT, unsubscribe: async () => { env.order.push('release'); return release(); } };
  const pushManager = { getSubscription: async () => (subscribed ? subscription : null) };
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager }) } });
}

const answer = (status: number) => new Response(JSON.stringify(status < 300 ? { ok: true } : { error: 'no' }), { status });
function server(...answers: (number | 'offline')[]) {
  const queue = [...answers];
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    env.order.push(`fetch:${String((init?.headers as Record<string, string>).authorization)}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === 'offline') throw new TypeError('Failed to fetch');
    return answer(next);
  });
}

beforeEach(() => {
  env.order.length = 0;
  env.unregister.mockClear();
  env.session = { storageKey: 'sb-x-auth-token', cookies: [{ name: 'sb-x-auth-token', value: 'c' }],
    generation: '', accessToken: 'leaving-token', userId: 'u-parent', sessionId: 's-1' };
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  browser();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('only a 2xx means the server dropped the device', () => {
  it('a server fault is tried once more, and the key is kept until it works', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    const fetcher = server(500, 200);
    expect(await detachPushDevice('leaving-token', fetcher)).toBe('detached');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(subscribed).toBe(true); // the server let go, so the browser keeps its channel
  });

  it.each([401, 429])('a %i is not retried and is not success: the browser closes its own channel', async (status) => {
    rememberPushDevice({ endpoint: ENDPOINT });
    const fetcher = server(status);
    expect(await detachPushDevice('leaving-token', fetcher)).toBe('released');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(subscribed).toBe(false);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  it('a server that stays down ends with the channel closed, not with a forgotten key and a live device', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    const fetcher = server(500, 'offline');
    expect(await detachPushDevice('leaving-token', fetcher)).toBe('released');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(subscribed).toBe(false);
  });

  it('an unsubscribe that never answers is bounded, then the channel is closed', async () => {
    vi.useFakeTimers();
    rememberPushDevice({ endpoint: ENDPOINT });
    const settled = detachPushDevice('leaving-token', vi.fn(() => new Promise<Response>(() => {})));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBe('released');
    expect(subscribed).toBe(false);
  });

  it('when neither the server nor the browser lets go, the key is kept and the caller is told', async () => {
    browser(async () => false);
    rememberPushDevice({ endpoint: ENDPOINT });
    expect(await detachPushDevice('leaving-token', server('offline'))).toBe('kept');
    expect(JSON.parse(store.get(STORAGE_KEY)!)).toEqual({ endpoint: ENDPOINT });
  });

  it('a native install that the server would not drop unregisters from its push provider', async () => {
    rememberPushDevice({ token: TOKEN });
    expect(await detachPushDevice('leaving-token', server(500))).toBe('released');
    expect(env.unregister).toHaveBeenCalledTimes(1);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  it('a clean detach asks the server once and touches nothing else (control)', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    const fetcher = server(200);
    expect(await detachPushDevice('leaving-token', fetcher)).toBe('detached');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(env.order).toEqual(['fetch:Bearer leaving-token']);
  });

  it('a device that registered nothing pays no wait (control)', () => {
    expect(detachPushDevice('leaving-token', server(200))).toBeNull();
  });
});

describe('sign-out', () => {
  it('revokes the token only after the failed detach has closed the channel', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    vi.stubGlobal('fetch', server(500));
    const result = signOutBrowserSession(captureSignOutIntent()!);
    expect(result.status).toBe('signed-out');
    expect(await result.revocation).toBe('confirmed');
    expect(env.order).toEqual(['fetch:Bearer leaving-token', 'fetch:Bearer leaving-token', 'release', 'revoke:leaving-token']);
    expect(subscribed).toBe(false);
  });

  it('finishing a server-side sign-out (revoke: false) still takes the device off the account', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    const fetcher = server(401); // the server already revoked this session
    vi.stubGlobal('fetch', fetcher);
    const result = signOutBrowserSession(captureSignOutIntent()!, { revoke: false, revocation: 'confirmed' });
    expect(result.status).toBe('signed-out');
    expect(await result.revocation).toBe('confirmed');
    expect(env.order).not.toContain('revoke:leaving-token');
    expect(subscribed).toBe(false);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  it('finishing a server-side sign-out whose cookies are already gone closes the channel without a session', async () => {
    rememberPushDevice({ endpoint: ENDPOINT });
    env.session = null;
    const fetcher = server(200);
    vi.stubGlobal('fetch', fetcher);
    const result = signOutBrowserSession({ kind: 'empty' }, { revoke: false, revocation: 'confirmed' });
    expect(await result.revocation).toBe('confirmed');
    expect(fetcher).not.toHaveBeenCalled();
    expect(subscribed).toBe(false);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});
