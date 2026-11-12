// POST /api/push/unsubscribe (Register B API-224863753D3F), driven over the
// in-memory database: the real getUser for the cookie session, and a bearer
// client whose token check is the only stand-in.
//
// Scope: who may remove a device and whose rows a removal can reach. The
// browser subscription shape is open PR #1172's and is not pinned here.
//
// Already proven elsewhere and not repeated:
//  - tests/a-push-device-belongs-to-one-account.test.ts: the leaving session's
//    bearer removes its device after cookies are gone; sign-out order.
//  - tests/a-signed-out-device-detach-passes-middleware.test.ts: middleware
//    lets the bearer-only detach through and keeps every other path at 401.
//  - tests/raw-body-boundaries.test.ts: the bounded body read.
//
// The delete is deliberately unconfirmed (zero rows = already removed), so a
// key that matches no row of the caller's answers 200 and changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const state = vi.hoisted(() => ({ db: null as unknown, bearerUsers: {} as Record<string, string> }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
// The bearer client is the same database seen through a token: a known token
// is its user, any other is refused as Supabase Auth refuses it.
vi.mock('@/lib/supabase/bearer', async (original) => ({
  ...await original<typeof import('@/lib/supabase/bearer')>(),
  createBearerClient: (token: string) => new Proxy(state.db as object, {
    get(target, key) {
      if (key !== 'auth') return Reflect.get(target, key, target);
      return {
        getUser: async (jwt: string) => (jwt === token && state.bearerUsers[jwt]
          ? { data: { user: { id: state.bearerUsers[jwt] } }, error: null }
          : { data: { user: null }, error: { name: 'AuthApiError', message: 'invalid JWT', status: 401 } }),
      };
    },
  }),
}));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true, retryAfter: 0 }) }));

const { POST } = await import('@/app/api/push/unsubscribe/route');

const FAMILY_A = '0a000000-0000-4000-8000-0000000000a2';
const FAMILY_B = '0b000000-0000-4000-8000-0000000000b2';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userOf = (h: 'A' | 'B', role: string) => `user-${h}-${role}`;
const SHARED = 'fixture-shared-device-token';

function database(userId: string | null) {
  const db = createInMemorySupabase({ userId, rpc: { rate_limit_hit: rateLimitHit } });
  for (const [h, familyId] of [['A', FAMILY_A], ['B', FAMILY_B]] as const) {
    db.seed('family_members', ROLES.map((role) => ({ id: `member-${h}-${role}`, family_id: familyId, user_id: userOf(h, role), role, is_active: true })));
    db.seed('push_devices', ROLES.flatMap((role) => [
      // Every account holds a row for the shared key (a historical double-registration) and one phone of its own.
      { id: `device-${h}-${role}-shared`, user_id: userOf(h, role), family_id: familyId, platform: 'android', provider: 'fcm', token: SHARED, device_key: SHARED, enabled: true },
      { id: `device-${h}-${role}-phone`, user_id: userOf(h, role), family_id: familyId, platform: 'android', provider: 'fcm', token: `${h}-${role}-phone`, device_key: `${h}-${role}-phone`, enabled: true },
    ]));
  }
  return db;
}

const detach = (body: unknown, headers: Record<string, string> = {}) => new Request('https://bubaly.example.com/api/push/unsubscribe', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const ids = (db: InMemorySupabase) => db.table('push_devices').map((d) => d.id as string).sort();
const allIds = () => ids(database(null));

beforeEach(() => {
  state.bearerUsers = {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('who may remove a push device', () => {
  it('API-224863753D3F a signed-out caller with no bearer gets 401 and nothing is removed', async () => {
    const db = database(null);
    state.db = db;
    const res = await POST(detach({ token: SHARED }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unsubscribe.unauthorized' });
    expect(ids(db)).toEqual(allIds());
    expect(db.table('rate_limits')).toEqual([]);
  });

  it('API-224863753D3F a bearer token Supabase refuses gets 401 even with a cookie session present, and nothing is removed', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = db;
    const res = await POST(detach({ token: SHARED }, { authorization: 'Bearer fixture-revoked-token' }));
    expect(res.status).toBe(401);
    expect(ids(db)).toEqual(allIds());
  });

  it.each(ROLES)('API-224863753D3F %s of household A removes only their own row for that key', async (role) => {
    const db = database(userOf('A', role));
    state.db = db;
    const res = await POST(detach({ token: SHARED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ids(db)).toEqual(allIds().filter((id) => id !== `device-A-${role}-shared`));
  });

  it('API-224863753D3F a bearer removes the bearer’s own row, not the row of the cookie session’s account', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = db;
    state.bearerUsers['fixture-bearer-a-teen'] = userOf('A', 'teen');
    const res = await POST(detach({ token: SHARED }, { authorization: 'Bearer fixture-bearer-a-teen' }));
    expect(res.status).toBe(200);
    expect(ids(db)).toEqual(allIds().filter((id) => id !== 'device-A-teen-shared'));
  });

  it('API-224863753D3F the thirty-first removal in a minute is 429 and removes nothing', async () => {
    const db = database(userOf('A', 'guest'));
    state.db = db;
    for (let i = 0; i < 30; i++) expect((await POST(detach({ token: `fixture-unknown-${i}` }))).status).toBe(200);
    const res = await POST(detach({ token: SHARED }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(ids(db)).toEqual(allIds());
  });
});

describe('another household’s ids', () => {
  it('API-224863753D3F a household-B device key is answered 200 and removes nothing of B', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = db;
    const res = await POST(detach({ token: 'B-parent-phone', user_id: userOf('B', 'parent'), family_id: FAMILY_B }));
    expect(res.status).toBe(200);
    expect(ids(db)).toEqual(allIds());
  });
});

describe('a write that fails', () => {
  it('API-224863753D3F a refused delete is 500 with a plain message, no database detail, and the row stays', async () => {
    const db = database(userOf('A', 'adult'));
    state.db = withFaults(db, (table, calls) => (table === 'push_devices' && calls.some((c) => c.method === 'delete') ? { message: 'INTERNAL delete detail' } : null));
    const res = await POST(detach({ token: SHARED }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'unsubscribe.couldNotRemovePushSubscription' });
    expect(text).not.toContain('INTERNAL');
    expect(ids(db)).toEqual(allIds());
  });
});
