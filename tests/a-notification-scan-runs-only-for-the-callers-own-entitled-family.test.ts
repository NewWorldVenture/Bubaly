// POST /api/notifications/generate (Register B API-FDA0AB66957A), end to end
// over the in-memory database: the real requireUserContext reading the
// session, the real plan gate (refuseUnlessEntitled), the real limiter, the
// real generation lease and the real generator. Only push dispatch is stubbed,
// at the lib/server/push seam tests/one-generator-per-family-at-a-time.test.ts
// already stubs.
//
// Already proven elsewhere and not repeated:
//  - tests/one-generator-per-family-at-a-time.test.ts: a Scan beside a cron
//    files each notice once; the lease is released after a pass.
//  - tests/the-notification-generator-says-what-it-could-not-check.test.ts:
//    a source that could not be read makes the Scan answer `incomplete`.
//  - tests/unreached-public-routes.test.ts: the source calls requireUserContext
//    before the service client.
//
// Added here: the context comes from the session, not a mock; every member
// role may scan and the rows land in their active family only; a family below
// the plan, a closed family, a rate-limited caller and a signed-out caller
// write nothing; a plan read that fails is an honest 503.
//
// The generator writes as the service role, so there is no RLS behind it: the
// active family from the session is the whole household boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const state = vi.hoisted(() => ({ db: null as unknown, dispatch: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true, retryAfter: 0 }) }));
vi.mock('@/lib/server/push', () => ({ dispatchPendingPushes: state.dispatch }));

const { POST } = await import('@/app/api/notifications/generate/route');

const NOW = new Date('2026-09-30T12:00:00.000Z');
const FAMILY = { A: '0a000000-0000-4000-8000-0000000000a4', B: '0b000000-0000-4000-8000-0000000000b4', C: '0c000000-0000-4000-8000-0000000000c4' } as const;
type Household = keyof typeof FAMILY;
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userOf = (h: Household, role: string) => `user-${h}-${role}`;
const DUAL_USER = 'user-dual';

function database(userId: string | null) {
  const db = createInMemorySupabase({
    userId,
    rpc: { rate_limit_hit: rateLimitHit },
    defaults: { notifications: { is_read: false, sent_at: null, pushed_at: null } },
    uniques: { app_settings: [['key']] },
  });
  // A: paid Family Basic. B: also paid. C: closed (locked) household.
  db.seed('families', [
    { id: FAMILY.A, name: 'Household A', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY.B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY.C, name: 'Household C', timezone: 'UTC', trial_ends_at: null, closed_at: '2026-09-01T00:00:00.000Z' },
  ]);
  db.seed('subscriptions', (['A', 'B', 'C'] as const).map((h) => ({ family_id: FAMILY[h], plan: 'basic', status: 'active', current_period_end: '2026-12-31T00:00:00.000Z' })));
  for (const h of ['A', 'B', 'C'] as const) {
    db.seed('family_members', ROLES.map((role) => ({
      id: `member-${h}-${role}`, family_id: FAMILY[h], user_id: userOf(h, role), role, is_active: true, display_name: `${h} ${role}`, birthday: null,
    })));
    // A chore due in three hours in each household: one `chore_due` notice per scan of that household.
    db.seed('chores', [{ id: `chore-${h}`, family_id: FAMILY[h], title: `${h}_CHORE` }]);
    db.seed('chore_assignments', [{ id: `assignment-${h}`, family_id: FAMILY[h], chore_id: `chore-${h}`, member_id: `member-${h}-child`, status: 'todo', due_at: '2026-09-30T15:00:00.000Z' }]);
  }
  db.seed('family_members', [
    { id: 'member-dual-A', family_id: FAMILY.A, user_id: DUAL_USER, role: 'guest', is_active: true, display_name: 'dual', birthday: null },
    { id: 'member-dual-B', family_id: FAMILY.B, user_id: DUAL_USER, role: 'parent', is_active: true, display_name: 'dual', birthday: null },
  ]);
  db.seed('user_preferences', [{ user_id: DUAL_USER, active_family_id: FAMILY.A }]);
  state.db = db;
  return db;
}

const scan = () => POST();
const notices = (db: InMemorySupabase, h?: Household) => db.table('notifications').filter((n) => !h || n.family_id === FAMILY[h]);
const leases = (db: InMemorySupabase) => db.table('app_settings').filter((r) => String(r.key).startsWith('notification_generation_lease'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.dispatch.mockReset().mockResolvedValue({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('who may run a notification scan', () => {
  it('API-FDA0AB66957A a signed-out caller is refused: nothing generated, nothing dispatched, no lease taken, no detail leaked', async () => {
    const db = database(null);
    const res = await scan();
    // The route answers this with its catch-all (see the PR's "Defects found"); what is pinned is that it is a refusal that writes nothing.
    expect(res.ok).toBe(false);
    expect(await res.json()).toEqual({ error: 'generate.couldNotRefreshNotifications' });
    expect(notices(db)).toEqual([]);
    expect(leases(db)).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it.each(ROLES)('API-FDA0AB66957A %s of household A scans household A only', async (role) => {
    const db = database(userOf('A', role));
    const res = await scan();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ created: notices(db, 'A').length, incomplete: false });
    expect(body.created).toBeGreaterThan(0);
    expect(notices(db).every((n) => n.family_id === FAMILY.A)).toBe(true);
    expect(notices(db, 'A').map((n) => n.type)).toContain('chore_due');
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(state.dispatch.mock.calls[0][1]).toEqual({ familyId: FAMILY.A });
    // The lease is given back when the pass is done.
    expect(leases(db).every((r) => r.key === `notification_generation_lease:v1:family:${FAMILY.A}`)).toBe(true);
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`notifications:generate:${FAMILY.A}:${userOf('A', role)}`]);
  });

  it('API-FDA0AB66957A a member of a closed household is refused with 403 and nothing is generated', async () => {
    const db = database(userOf('C', 'parent'));
    const res = await scan();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'account_closed' });
    expect(notices(db)).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('API-FDA0AB66957A a household below the plan the page needs is refused with 403 and nothing is generated', async () => {
    const db = database(userOf('B', 'parent'));
    db.replace('subscriptions', db.table('subscriptions').filter((s) => s.family_id !== FAMILY.B));
    db.table('families').find((f) => f.id === FAMILY.B)!.trial_ends_at = '2026-09-01T00:00:00.000Z';
    const res = await scan();
    expect(res.status).toBe(403);
    expect(notices(db)).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('API-FDA0AB66957A the eleventh scan in a minute is 429 with Retry-After and generates nothing more', async () => {
    const db = database(userOf('A', 'teen'));
    for (let i = 0; i < 10; i++) expect((await scan()).status).toBe(200);
    const before = notices(db).length;
    const res = await scan();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(notices(db)).toHaveLength(before);
    expect(state.dispatch).toHaveBeenCalledTimes(10);
  });
});

describe('another household', () => {
  it('API-FDA0AB66957A an account in A and B with A active scans A only, though it is B’s parent', async () => {
    const db = database(DUAL_USER);
    expect((await scan()).status).toBe(200);
    expect(notices(db, 'A').length).toBeGreaterThan(0);
    expect(notices(db, 'B')).toEqual([]);
    expect(state.dispatch.mock.calls.map((c) => c[1])).toEqual([{ familyId: FAMILY.A }]);
  });
});

describe('a read that fails', () => {
  it('API-FDA0AB66957A a plan read that fails is 503 "unavailable", generates nothing and leaks no detail', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: 'INTERNAL subscriptions relation detail' } : null));
    const res = await scan();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'unavailable' });
    expect(text).not.toContain('INTERNAL');
    expect(notices(db)).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('API-FDA0AB66957A a lease that cannot be read is a 500 with a plain message, not "nothing to do"', async () => {
    const db = database(userOf('A', 'parent'));
    state.db = withFaults(db, (table, calls) => (table === 'app_settings' && calls.some((c) => String(c.args[1]).startsWith('notification_generation_lease'))
      ? { message: 'INTERNAL app_settings detail' } : null));
    const res = await scan();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'generate.couldNotRefreshNotifications' });
    expect(text).not.toContain('INTERNAL');
    expect(notices(db)).toEqual([]);
  });
});
