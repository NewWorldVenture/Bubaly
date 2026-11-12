// POST /api/push/subscribe (Register B API-B502B4642DF3), driven over the
// in-memory database with the real getUser reading the session.
//
// Scope: who may register, which account and household the row is written
// under, and what a refused or failed request leaves behind. The browser
// subscription shape (endpoint, keys, providers) is open PR #1172's and is not
// pinned here; every case registers one plain native token.
//
// Already proven elsewhere and not repeated:
//  - tests/a-push-device-belongs-to-one-account.test.ts: a token held by a
//    previous account is moved to the caller; a failed detach registers nothing.
//  - tests/push-endpoint-ssrf-guard.test.ts: the DNS endpoint guard.
//  - tests/a-slow-push-endpoint-cannot-hold-up-everyone-elses-pushes.test.ts:
//    the per-account device cap.
//  - tests/raw-body-boundaries.test.ts: the bounded body read.
//
// There is no role gate on this route by design: every signed-in member
// registers their OWN device, so each role is shown to succeed for itself only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const state = vi.hoisted(() => ({ db: null as unknown, deliverable: vi.fn(async () => true) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
// DNS is the network seam (tests/push-endpoint-ssrf-guard.test.ts covers it).
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: state.deliverable }));
// The in-process limiter is a cache in front of the durable rate_limit_hit,
// which stays real; held open so cases sharing a user id do not throttle each other.
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true, retryAfter: 0 }) }));

const { POST } = await import('@/app/api/push/subscribe/route');

const FAMILY_A = '0a000000-0000-4000-8000-0000000000a1';
const FAMILY_B = '0b000000-0000-4000-8000-0000000000b1';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userOf = (h: 'A' | 'B', role: string) => `user-${h}-${role}`;
const TOKEN = 'fixture-native-token-0001';

function database(userId: string | null) {
  const db = createInMemorySupabase({ userId, rpc: { rate_limit_hit: rateLimitHit } });
  for (const [h, familyId] of [['A', FAMILY_A], ['B', FAMILY_B]] as const) {
    db.seed('family_members', ROLES.map((role) => ({ id: `member-${h}-${role}`, family_id: familyId, user_id: userOf(h, role), role, is_active: true })));
  }
  db.seed('push_devices', [
    { id: 'device-B-parent-phone', user_id: userOf('B', 'parent'), family_id: FAMILY_B, platform: 'android', provider: 'fcm', token: 'b-parent-phone', device_key: 'b-parent-phone', enabled: true, last_seen_at: '2026-09-01T00:00:00.000Z' },
    { id: 'device-A-adult-tablet', user_id: userOf('A', 'adult'), family_id: FAMILY_A, platform: 'android', provider: 'fcm', token: 'a-adult-tablet', device_key: 'a-adult-tablet', enabled: true, last_seen_at: '2026-09-01T00:00:00.000Z' },
  ]);
  return db;
}

const register = (body: unknown) => new Request('https://bubaly.example.com/api/push/subscribe', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const nativeBody = (extra: Record<string, unknown> = {}) => ({ platform: 'android', provider: 'fcm', token: TOKEN, ...extra });
const devices = (db: InMemorySupabase) => db.table('push_devices');
const snapshot = (db: InMemorySupabase) => JSON.parse(JSON.stringify(devices(db))) as unknown[];

beforeEach(() => {
  state.deliverable.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('who may register a push device', () => {
  it('API-B502B4642DF3 a signed-out caller gets 401: no row, no limiter hit, no DNS lookup', async () => {
    const db = database(null);
    state.db = db;
    const before = snapshot(db);
    const res = await POST(register(nativeBody()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'subscribe.unauthorized' });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('rate_limits')).toEqual([]);
    expect(state.deliverable).not.toHaveBeenCalled();
  });

  it.each(ROLES)('API-B502B4642DF3 %s of household A registers the device to themselves under A', async (role) => {
    const db = database(userOf('A', role));
    state.db = db;
    const res = await POST(register(nativeBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const mine = devices(db).filter((d) => d.device_key === TOKEN);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      user_id: userOf('A', role), family_id: FAMILY_A, enabled: true,
      created_by: userOf('A', role), updated_by: userOf('A', role),
    });
    // Household B's device is untouched.
    expect(devices(db).find((d) => d.id === 'device-B-parent-phone')).toMatchObject({ user_id: userOf('B', 'parent'), enabled: true });
  });

  it('API-B502B4642DF3 the parent of household B registers under B, not under A', async () => {
    const db = database(userOf('B', 'parent'));
    state.db = db;
    expect((await POST(register(nativeBody()))).status).toBe(200);
    expect(devices(db).filter((d) => d.device_key === TOKEN).map((d) => [d.user_id, d.family_id])).toEqual([[userOf('B', 'parent'), FAMILY_B]]);
  });

  it('API-B502B4642DF3 a signed-in account with no family registers an unscoped device of its own', async () => {
    const db = database('user-without-family');
    state.db = db;
    expect((await POST(register(nativeBody()))).status).toBe(200);
    expect(devices(db).filter((d) => d.device_key === TOKEN).map((d) => [d.user_id, d.family_id])).toEqual([['user-without-family', null]]);
  });

  it('API-B502B4642DF3 the twenty-first registration in a minute is 429 with Retry-After and writes no new row', async () => {
    const db = database(userOf('A', 'teen'));
    state.db = db;
    for (let i = 0; i < 20; i++) expect((await POST(register(nativeBody({ token: `fixture-token-${i}` })))).status).toBe(200);
    const res = await POST(register(nativeBody({ token: 'fixture-token-over' })));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(devices(db).some((d) => d.device_key === 'fixture-token-over')).toBe(false);
  });
});

describe('another household’s ids', () => {
  it('API-B502B4642DF3 a user_id and family_id of household B in the body are ignored: the row is the caller’s, under A', async () => {
    const db = database(userOf('A', 'child'));
    state.db = db;
    const res = await POST(register(nativeBody({ user_id: userOf('B', 'parent'), family_id: FAMILY_B, userId: userOf('B', 'parent'), familyId: FAMILY_B })));
    // The strict parser does not read those keys, so the registration stands as the caller's own.
    expect(res.status).toBe(200);
    const mine = devices(db).filter((d) => d.device_key === TOKEN);
    expect(mine.map((d) => [d.user_id, d.family_id])).toEqual([[userOf('A', 'child'), FAMILY_A]]);
    expect(devices(db).filter((d) => d.user_id === userOf('B', 'parent')).map((d) => d.id)).toEqual(['device-B-parent-phone']);
  });

  it('API-B502B4642DF3 registering another account’s token moves only that one row; the other account’s other devices stay', async () => {
    const db = database(userOf('A', 'teen'));
    state.db = db;
    expect((await POST(register(nativeBody({ token: 'b-parent-phone' })))).status).toBe(200);
    expect(devices(db).filter((d) => d.device_key === 'b-parent-phone').map((d) => d.user_id)).toEqual([userOf('A', 'teen')]);
    expect(devices(db).find((d) => d.id === 'device-A-adult-tablet')).toMatchObject({ user_id: userOf('A', 'adult'), enabled: true });
  });
});

describe('a read that fails', () => {
  it('API-B502B4642DF3 a refused family lookup is 503 and registers nothing, with no database detail in the answer', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = withFaults(db, (table) => (table === 'family_members' ? { message: 'INTERNAL family_members relation detail' } : null));
    const before = snapshot(db);
    const res = await POST(register(nativeBody()));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'subscribe.couldNotRegisterThisDevice' });
    expect(text).not.toContain('INTERNAL');
    expect(snapshot(db)).toEqual(before);
  });

  it('API-B502B4642DF3 a refused write is 500 with a plain message, and no row is left', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = withFaults(db, (table, calls) => (table === 'push_devices' && calls.some((c) => c.method === 'upsert') ? { message: 'INTERNAL upsert detail' } : null));
    const res = await POST(register(nativeBody()));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'subscribe.couldNotSavePushSubscription' });
    expect(text).not.toContain('INTERNAL');
    expect(devices(db).some((d) => d.device_key === TOKEN)).toBe(false);
  });
});
