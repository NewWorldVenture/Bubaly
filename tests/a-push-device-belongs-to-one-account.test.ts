// One physical device belongs to one account.
//
// push_devices is unique on (user_id, device_key), and device_key IS the
// FCM/APNs token or web endpoint. Nothing moved a token off the previous
// account: when a parent signed out of a shared tablet and a teen signed in,
// both rows pointed at the tablet, so it kept receiving the parent's private
// notifications and every family-wide notice buzzed it twice. And sign-out
// itself never removed the row, so a signed-out device kept receiving the
// leaving account's notifications even before anyone else signed in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  cookieUser: null as { id: string } | null,
  db: null as unknown,
  serviceDeleteError: null as unknown,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUser: async () => state.cookieUser }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: async () => true }));
vi.mock('@/lib/supabase/bearer', async (original) => ({
  ...await original<typeof import('@/lib/supabase/bearer')>(),
  createBearerClient: () => state.db,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => state.db,
  createServiceClient: () => {
    const db = state.db as InMemorySupabase;
    if (!state.serviceDeleteError) return db;
    return { from: (table: string) => (table === 'push_devices'
      ? { select: () => ({ eq: () => ({ neq: async () => ({ data: null, error: state.serviceDeleteError }) }) }) }
      : db.from(table)) };
  },
}));

const { POST: subscribe } = await import('@/app/api/push/subscribe/route');
const { POST: unsubscribe } = await import('@/app/api/push/unsubscribe/route');

const TOKEN = 'fixture-shared-tablet-token';
let mem: InMemorySupabase;

function seed(userId: string) {
  mem = createInMemorySupabase({ userId });
  mem.seed('family_members', [
    { id: 'm-parent', family_id: 'fam-1', user_id: 'u-parent', role: 'parent', is_active: true },
    { id: 'm-teen', family_id: 'fam-1', user_id: 'u-teen', role: 'teen', is_active: true },
  ]);
  mem.seed('push_devices', [
    { id: 'dev-parent-tablet', user_id: 'u-parent', family_id: 'fam-1', platform: 'android', provider: 'fcm', token: TOKEN, device_key: TOKEN, enabled: true },
    { id: 'dev-parent-phone', user_id: 'u-parent', family_id: 'fam-1', platform: 'android', provider: 'fcm', token: 'parent-phone', device_key: 'parent-phone', enabled: true },
  ]);
  state.db = mem;
}

const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://bubaly.test/api/push', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  state.cookieUser = null;
  state.serviceDeleteError = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('registering a device takes it off any other account', () => {
  it("a teen signing in on the parent's tablet leaves the tablet registered to the teen only", async () => {
    seed('u-teen');
    state.cookieUser = { id: 'u-teen' };
    const res = await subscribe(post({ platform: 'android', provider: 'fcm', token: TOKEN }));
    expect(res.status).toBe(200);
    const owners = mem.table('push_devices').filter((d) => d.device_key === TOKEN).map((d) => d.user_id);
    expect(owners).toEqual(['u-teen']);
    // The parent's OTHER device is theirs and is left alone.
    expect(mem.table('push_devices').some((d) => d.id === 'dev-parent-phone')).toBe(true);
  });

  it('re-registering your own device keeps your row', async () => {
    seed('u-parent');
    state.cookieUser = { id: 'u-parent' };
    expect((await subscribe(post({ platform: 'android', provider: 'fcm', token: TOKEN }))).status).toBe(200);
    expect(mem.table('push_devices').filter((d) => d.device_key === TOKEN).map((d) => d.user_id)).toEqual(['u-parent']);
  });

  it('registers nothing when the previous owner cannot be detached', async () => {
    seed('u-teen');
    state.cookieUser = { id: 'u-teen' };
    state.serviceDeleteError = { message: 'Fixture database unavailable' };
    const res = await subscribe(post({ platform: 'android', provider: 'fcm', token: TOKEN }));
    expect(res.status).toBe(503);
    expect(mem.table('push_devices').some((d) => d.user_id === 'u-teen')).toBe(false);
  });
});

describe("signing out removes this device from the leaving account", () => {
  it("the unsubscribe route accepts the leaving session's bearer token after cookies are gone", async () => {
    seed('u-parent');
    state.cookieUser = null; // the browser cleared the cookies synchronously
    const res = await unsubscribe(post({ token: TOKEN }, { authorization: 'Bearer leaving-session-token' }));
    expect(res.status).toBe(200);
    expect(mem.table('push_devices').some((d) => d.id === 'dev-parent-tablet')).toBe(false);
    expect(mem.table('push_devices').some((d) => d.id === 'dev-parent-phone')).toBe(true);
  });

  it('sign-out detaches the remembered device before the token is revoked', async () => {
    vi.resetModules();
    const order: string[] = [];
    vi.doMock('@/lib/auth/browser-session-storage', () => {
      let current: unknown = { storageKey: 'sb-x-auth-token', cookies: [{ name: 'sb-x-auth-token', value: 'c' }],
        generation: '', accessToken: 'leaving-token', userId: 'u-parent', sessionId: 's-1' };
      return {
        captureBrowserSessionSnapshot: () => current,
        clearBrowserSessionSnapshot: () => { current = null; return true; },
      };
    });
    vi.doMock('@/lib/auth/session-change', () => ({ notifySessionStorageChanged: () => {} }));
    vi.doMock('@/lib/offline/cache', () => ({ clearAllCache: () => {} }));
    vi.doMock('@/lib/supabase/client', () => ({ createClient: () => ({ realtime: { setAuth: async () => {} } }) }));
    vi.doMock('@/lib/auth/revoke-session', () => ({ revokeSessionToken: async (token: string) => { order.push(`revoke:${token}`); return 'confirmed'; } }));
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      order.push(`fetch:${url}:${(init.headers as Record<string, string>).authorization}:${String(init.body)}`);
      return new Response('{"ok":true}');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { rememberPushDevice } = await import('@/lib/push/device-registration');
      const { captureSignOutIntent, signOutBrowserSession } = await import('@/lib/auth/browser-signout');
      rememberPushDevice({ token: TOKEN });
      const result = signOutBrowserSession(captureSignOutIntent()!);
      expect(result.status).toBe('signed-out');
      expect(await result.revocation).toBe('confirmed');
      expect(order).toEqual([
        `fetch:/api/push/unsubscribe:Bearer leaving-token:${JSON.stringify({ token: TOKEN })}`,
        'revoke:leaving-token',
      ]);
      // Forgotten, so the next account's sign-out does not try it again.
      expect(store.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('@/lib/auth/browser-session-storage');
      vi.doUnmock('@/lib/auth/session-change');
      vi.doUnmock('@/lib/offline/cache');
      vi.doUnmock('@/lib/supabase/client');
      vi.doUnmock('@/lib/auth/revoke-session');
    }
  });

  it('both registration paths remember the device they registered', () => {
    for (const file of ['components/native/push-registrar.tsx', 'components/native/enable-push-button.tsx']) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/if \(res\.ok\) rememberPushDevice\(payload/);
    }
  });
});
