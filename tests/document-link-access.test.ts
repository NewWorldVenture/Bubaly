import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeDocumentLink } from '@/lib/services/paperwork/link-access';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('Access must use the caller client'); },
  createServer: () => { throw new Error('Access must use the supplied client'); },
}));
const USER = '10000000-0000-4000-8000-000000000001';
const FAMILY = '20000000-0000-4000-8000-000000000002';
const MEMBER = '30000000-0000-4000-8000-000000000003';
const OTHER = '40000000-0000-4000-8000-000000000004';
const MEMBER_TWO = '50000000-0000-4000-8000-000000000005';
const member = (role = 'parent') => ({ id: MEMBER, family_id: FAMILY, user_id: USER, role, is_active: true });
const context = (role = 'parent'): UserContext => ({
  user: { id: USER, email: 'member@example.com' },
  active: { familyId: FAMILY, role, member: member(role), family: { id: FAMILY } },
  memberships: [{ familyId: FAMILY, role, member: member(role), family: { id: FAMILY } }],
} as unknown as UserContext);
type Reply = { data: unknown; error: unknown; count?: number | null };
type Query = { table: string; selection?: string; options?: unknown; filters: [string, unknown][] };
function fixture(role = 'parent') {
  const rows: Record<string, Reply> = {
    family_members: { data: [member(role)], error: null, count: 1 },
    user_preferences: { data: { active_family_id: FAMILY }, error: null },
    app_settings: { data: { value: {} }, error: null },
    families: { data: { id: FAMILY, trial_ends_at: null, closed_at: null }, error: null },
    subscriptions: { data: [{ family_id: FAMILY, plan: 'basic', status: 'active' }], error: null, count: 1 },
  };
  const auth = { data: { user: { id: USER, email: 'member@example.com' } as { id: string; email: string } | null }, error: null as unknown };
  const admin = { data: false as unknown, error: null as unknown };
  const reject = new Set<string>();
  const queries: Query[] = [];
  const getUser = vi.fn(async () => {
    if (reject.has('auth')) throw new Error('offline');
    return auth;
  });
  const rpc = vi.fn(async (name: string) => {
    expect(name).toBe('is_super_admin');
    if (reject.has('rpc')) throw new Error('offline');
    return admin;
  });
  const db = {
    auth: { getUser }, rpc,
    from(table: string) {
      if (!Object.hasOwn(rows, table)) throw new Error(`Unexpected table ${table}`);
      const query: Query = { table, filters: [] };
      queries.push(query);
      const chain = {
        select(selection: string, options?: unknown) { query.selection = selection; query.options = options; return chain; },
        eq(column: string, value: unknown) { query.filters.push([column, value]); return chain; },
        in(column: string, value: unknown) { query.filters.push([column, value]); return chain; },
        maybeSingle() { return chain; },
        then(resolve: (reply: Reply) => unknown, fail: (error: unknown) => unknown) {
          return (reject.has(table) ? Promise.reject(new Error('offline')) : Promise.resolve(rows[table])).then(resolve, fail);
        },
      };
      return chain;
    },
  } as unknown as ServiceScope['db'];
  return { db, rows, auth, admin, reject, queries, getUser, rpc };
}
const CHANGED = { ok: false, reason: 'context_changed', retryable: false };
const DENIED = { ok: false, reason: 'access_denied', retryable: false };
const UNAVAILABLE = { ok: false, reason: 'unavailable', retryable: true };

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('fresh document link identity', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('preserves existing %s member access for manual and inbox links', async (role) => {
    const f = fixture(role);
    expect(await authorizeDocumentLink(context(role), f.db, false)).toEqual({ ok: true });
    expect(f.queries.map((query) => query.table)).toEqual(['family_members', 'user_preferences']);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(await authorizeDocumentLink(context(role), f.db, true)).toEqual({ ok: true });
  });

  it('scopes proof queries to the authenticated user and selected household', async () => {
    const f = fixture();
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    expect(f.queries.find((query) => query.table === 'family_members')).toMatchObject({
      options: { count: 'exact' }, filters: [['user_id', USER], ['is_active', true]],
    });
    expect(f.queries.find((query) => query.table === 'user_preferences')?.filters).toEqual([['user_id', USER]]);
    expect(f.queries.find((query) => query.table === 'families')?.filters).toEqual([['id', FAMILY]]);
    expect(f.queries.find((query) => query.table === 'subscriptions')).toMatchObject({
      options: { count: 'exact' }, filters: [['family_id', FAMILY], ['status', ['active', 'trialing']]],
    });
    expect(f.queries.find((query) => query.table === 'app_settings')?.filters).toEqual([['key', 'feature_tiers']]);
  });

  it.each([null, { active_family_id: null }, { active_family_id: OTHER }])('preserves successful absent/stale preference fallback: %j', async (prefs) => {
    const f = fixture();
    f.rows.user_preferences.data = prefs;
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual({ ok: true });
  });

  it.each(['sign_out', 'other_user', 'role', 'member', 'removed', 'family'])('invalidates the original context after %s', async (change) => {
    const f = fixture();
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual({ ok: true });
    if (change === 'sign_out') f.auth.data.user = null;
    if (change === 'other_user') f.auth.data.user!.id = OTHER;
    if (change === 'role') f.rows.family_members.data = [member('teen')];
    if (change === 'member') f.rows.family_members.data = [{ ...member(), id: MEMBER_TWO }];
    if (change === 'removed') f.rows.family_members = { data: [], error: null, count: 0 };
    if (change === 'family') {
      f.rows.family_members = { data: [member(), { ...member(), id: MEMBER_TWO, family_id: OTHER }], error: null, count: 2 };
      f.rows.user_preferences.data = { active_family_id: OTHER };
    }
    const before = f.queries.length;
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(CHANGED);
    expect(f.queries.slice(before).every((query) => ['family_members', 'user_preferences'].includes(query.table))).toBe(true);
  });

  it('distinguishes a missing session from unavailable authentication', async () => {
    const f = fixture();
    f.auth.error = { name: 'AuthSessionMissingError' };
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(CHANGED);
    f.auth.error = { code: 'session_missing' };
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(CHANGED);
    f.auth.error = { code: 'unexpected_failure' };
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(UNAVAILABLE);
    expect(f.queries).toHaveLength(0);
  });

  it.each(['auth', 'family_members', 'user_preferences'])('fails closed on a rejected %s read', async (table) => {
    const f = fixture(); f.reject.add(table);
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(UNAVAILABLE);
  });

  it.each(['family_members', 'user_preferences'])('fails closed on a returned %s error despite stale data', async (table) => {
    const f = fixture(); f.rows[table].error = { code: 'offline' };
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(UNAVAILABLE);
  });

  it.each(['count', 'unknown_count', 'foreign_user', 'inactive', 'malformed_preferences'])('rejects incomplete or invalid context proof: %s', async (kind) => {
    const f = fixture();
    if (kind === 'count') f.rows.family_members.count = 2;
    if (kind === 'unknown_count') f.rows.family_members.count = null;
    if (kind === 'foreign_user') f.rows.family_members.data = [{ ...member(), user_id: OTHER }];
    if (kind === 'inactive') f.rows.family_members.data = [{ ...member(), is_active: false }];
    if (kind === 'malformed_preferences') f.rows.user_preferences.data = { active_family_id: 7 };
    expect(await authorizeDocumentLink(context(), f.db, false)).toEqual(UNAVAILABLE);
  });
});

describe('selected Inbox link feature and entitlement', () => {
  it('applies the default Basic tier without imposing Contact Center Plus', async () => {
    const f = fixture(); f.rows.app_settings.data = null;
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.rows.subscriptions = { data: [], error: null, count: 0 };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(DENIED);
  });

  it.each(['off', 'plus', 'free'])('honors current %s override on each retry', async (tier) => {
    const f = fixture();
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.rows.app_settings.data = { value: { 'communications-hub': tier } };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(tier === 'free' ? { ok: true } : DENIED);
  });

  it('grants a current Basic trial and rejects expired/closed households even with a free override', async () => {
    const f = fixture(); f.rows.subscriptions = { data: [], error: null, count: 0 };
    f.rows.families.data = { id: FAMILY, trial_ends_at: '2999-01-01T00:00:00+00:00', closed_at: null };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.rows.app_settings.data = { value: { 'communications-hub': 'free' } };
    f.rows.families.data = { id: FAMILY, trial_ends_at: '2000-01-01T00:00:00Z', closed_at: null };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(DENIED);
    f.rows.families.data = { id: FAMILY, trial_ends_at: null, closed_at: '2000-01-01T00:00:00Z' };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(DENIED);
  });

  it('uses the highest valid paid subscription, including legacy plans', async () => {
    const f = fixture();
    f.rows.subscriptions = { data: [
      { family_id: FAMILY, plan: 'free', status: 'trialing' },
      { family_id: FAMILY, plan: 'family_annual', status: 'active' },
    ], error: null, count: 2 };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.rows.subscriptions.data = [
      { family_id: FAMILY, plan: 'basic', status: 'trialing' },
      { family_id: FAMILY, plan: 'plus_annual', status: 'active' },
    ];
    f.rows.app_settings.data = { value: { 'communications-hub': 'plus' } };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
  });

  it.each(['app_settings', 'families', 'subscriptions'])('does not assume access after a returned or rejected %s failure', async (table) => {
    const f = fixture(); f.rows[table].error = { code: 'offline' };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
    f.rows[table].error = null; f.reject.add(table);
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
  });

  it.each(['missing_family', 'foreign_family', 'timestamp', 'foreign_subscription', 'subscription_count', 'unknown_count', 'unknown_plan', 'settings', 'override'])('rejects malformed or partial access proof: %s', async (kind) => {
    const f = fixture();
    if (kind === 'missing_family') f.rows.families.data = null;
    if (kind === 'foreign_family') f.rows.families.data = { id: OTHER, trial_ends_at: null, closed_at: null };
    if (kind === 'timestamp') f.rows.families.data = { id: FAMILY, trial_ends_at: '2999-02-30T00:00:00Z', closed_at: null };
    if (kind === 'foreign_subscription') f.rows.subscriptions.data = [{ family_id: OTHER, plan: 'plus', status: 'active' }];
    if (kind === 'subscription_count') f.rows.subscriptions.count = 2;
    if (kind === 'unknown_count') f.rows.subscriptions.count = null;
    if (kind === 'unknown_plan') f.rows.subscriptions.data = [{ family_id: FAMILY, plan: 'premium', status: 'active' }];
    if (kind === 'settings') f.rows.app_settings.data = { value: [] };
    if (kind === 'override') f.rows.app_settings.data = { value: { 'communications-hub': 'typo' } };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
  });

  it('uses fresh auth email and database admin proof, preserving current preview access', async () => {
    const f = fixture(); f.rows.app_settings.data = { value: { 'communications-hub': 'off' } };
    const staleAdmin = context(); staleAdmin.user.email = 'daniel.hughen@gmail.com';
    expect(await authorizeDocumentLink(staleAdmin, f.db, true)).toEqual(DENIED);
    f.auth.data.user!.email = 'daniel.hughen@gmail.com';
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.auth.data.user!.email = 'member@example.com'; f.admin.data = true;
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual({ ok: true });
    f.rows.family_members = { data: [], error: null, count: 0 };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(CHANGED);
  });

  it('does not treat a missing or failed admin proof as a normal grant', async () => {
    const f = fixture(); f.admin.data = null;
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
    f.admin.data = true; f.admin.error = { code: 'offline' };
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
    f.admin.error = null; f.reject.add('rpc');
    expect(await authorizeDocumentLink(context(), f.db, true)).toEqual(UNAVAILABLE);
  });
});
