// API-95D8CD8A9A26 — GET /api/subscriptions/price-history, driven end to end.
//
// tests/subscription-price-history-api.test.ts pins this handler against a
// scripted builder: query validation, the filters it sends, coverage states
// and every scripted read failure. Here the real handler runs over the
// in-memory database with the real getUserContext and plan resolver, seeded
// with two households that track a subscription of the SAME name, so the cases
// show that an id of household B finds nothing, that A's history is built only
// from A's charges, and that a read-only review writes nothing.
//
// Isolation note: the in-memory database applies no RLS. These cases prove the
// route's own `family_id` filters; in production RLS is a second boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => h.db,
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

import { GET } from '@/app/api/subscriptions/price-history/route';

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = typeof ROLES[number];
const userOf = (role: Role) => `a1000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const memberOf = (role: Role) => `a2000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const USER_B = 'b1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'b2000000-0000-4000-8000-000000000001';
const ACCOUNT_A = 'a6000000-0000-4000-8000-000000000001';
const ACCOUNT_B = 'b6000000-0000-4000-8000-000000000001';
const SUB_A = 'a7000000-0000-4000-8000-000000000001';
const SUB_B = 'b7000000-0000-4000-8000-000000000001';
const INTERNAL = 'relation "subscriptions_tracked" internal detail 0xDEADBEEF';
const SOURCE_TABLES = ['transactions', 'subscriptions_tracked', 'financial_accounts'];

function build(userId: string | null, opts: { plan?: string | null; tiers?: Record<string, string>; noteA?: string | null } = {}) {
  const db = createInMemorySupabase({ userId, rpc: { is_super_admin: () => false } });
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: memberOf(role), family_id: FAMILY_A, user_id: userOf(role), role, is_active: true })),
    { id: MEMBER_B, family_id: FAMILY_B, user_id: USER_B, role: 'parent', is_active: true },
  ]);
  if (opts.plan !== null) db.seed('subscriptions', [{ family_id: FAMILY_A, plan: opts.plan ?? 'basic', status: 'active', current_period_end: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY_B, plan: 'plus', status: 'active', current_period_end: null }]);
  db.seed('app_settings', [{ key: 'feature_tiers', value: opts.tiers ?? {} }]);
  db.seed('financial_accounts', [
    { id: ACCOUNT_A, family_id: FAMILY_A, currency: 'USD' },
    { id: ACCOUNT_B, family_id: FAMILY_B, currency: 'USD' },
  ]);
  const series = (family: string, prefix: string, amounts: number[], account: string, member: string) =>
    ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({
      id: `${prefix}-${i}`, family_id: family, name: 'Example Media', amount: amounts[i], type: 'expense', date, category: 'Subscriptions', account_id: account, member_id: member,
    }));
  db.seed('transactions', [
    ...series(FAMILY_A, 'txn-a', [15, 15, 18], ACCOUNT_A, memberOf('parent')),
    ...series(FAMILY_B, 'txn-b', [40, 41, 42], ACCOUNT_B, MEMBER_B),
  ]);
  db.seed('subscriptions_tracked', [
    { id: SUB_A, family_id: FAMILY_A, name: 'Example Media', cost_cents: 1500, cadence: 'monthly', note: opts.noteA ?? null },
    { id: SUB_B, family_id: FAMILY_B, name: 'Example Media', cost_cents: 4000, cadence: 'monthly', note: 'B private note' },
  ]);
  h.db = db;
  return db;
}

const get = (id: string) => GET(new Request(`http://localhost/api/subscriptions/price-history?subscriptionId=${id}`));
const snapshot = (db: InMemorySupabase) => JSON.stringify(SOURCE_TABLES.map((t) => db.table(t)));
const touched = (db: InMemorySupabase) => db.log.map((entry) => entry.table).filter((t) => SOURCE_TABLES.includes(t));
const B_LEAKS = [FAMILY_B, 'txn-b-', ACCOUNT_B, MEMBER_B, 'B private note', SUB_B];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/subscriptions/price-history over a two-household database', () => {
  it('API-95D8CD8A9A26 signed-out: 401 and no household source is read', async () => {
    const db = build(null);
    const response = await get(SUB_A);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('signed_out');
    expect(touched(db)).toEqual([]);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('API-95D8CD8A9A26 a %s of household A is refused 403 before any money source is read', async (role) => {
    const db = build(userOf(role));
    const response = await get(SUB_A);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('role_required');
    expect(touched(db)).toEqual([]);
  });

  it.each(['parent', 'adult'] as const)("API-95D8CD8A9A26 a %s gets A's subscription history from A's charges only, and the review writes nothing", async (role) => {
    const db = build(userOf(role));
    const before = snapshot(db);
    const response = await get(SUB_A);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.familyId).toBe(FAMILY_A);
    expect(body.context).toEqual({ familyId: FAMILY_A, userId: userOf(role), memberId: memberOf(role), role, active: true });
    expect(body.history.state).toBe('matched');
    expect(body.history.subscription).toEqual({ id: SUB_A, name: 'Example Media', costCents: 1500, cadence: 'monthly', note: null });
    expect(body.history.coverage).toMatchObject({ state: 'complete', totalRecords: 3, recordsRead: 3 });
    expect(body.history.groups).toHaveLength(1);
    expect(body.history.groups[0].evidence.map((e: Row) => [e.recordId, e.amountCents, e.differenceFromTrackedCents]))
      .toEqual([['txn-a-0', 1500, 0], ['txn-a-1', 1500, 0], ['txn-a-2', 1800, 300]]);
    const text = JSON.stringify(body);
    for (const leak of B_LEAKS) expect(text).not.toContain(leak);
    expect(snapshot(db)).toBe(before);
  });

  it("API-95D8CD8A9A26 household B's subscription id is 404 under household A and nothing of B is returned", async () => {
    const db = build(userOf('parent'));
    const before = snapshot(db);
    const response = await get(SUB_B);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('not_found');
    for (const leak of B_LEAKS) expect(text).not.toContain(leak);
    expect(touched(db)).not.toContain('transactions');
    expect(snapshot(db)).toBe(before);
  });

  it("API-95D8CD8A9A26 a note in A that references B's transaction ids does not pull B's charges in", async () => {
    build(userOf('parent'), { noteA: 'see transactions/txn-b-0 and transactions/txn-b-1' });
    const body = await (await get(SUB_A)).json();
    expect(body.history.unresolvedSourceReferences).toBe(2);
    const ids = body.history.groups.flatMap((g: { evidence: Row[] }) => g.evidence.map((e) => e.recordId));
    expect(ids.sort()).toEqual(['txn-a-0', 'txn-a-1', 'txn-a-2']);
  });

  it('API-95D8CD8A9A26 a family below the subscription-tracking tier is refused 403 before the subscription is read', async () => {
    const db = build(userOf('parent'), { plan: null });
    const response = await get(SUB_A);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('plan_required');
    expect(touched(db)).toEqual([]);
  });

  it('API-95D8CD8A9A26 a failed subscription read is 503, not "not found", with no internal text', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'subscriptions_tracked' ? { message: INTERNAL } : null));
    const response = await get(SUB_A);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('source_unavailable');
    expect(text).not.toContain(INTERNAL);
  });

  it('API-95D8CD8A9A26 a failed charge read is 503, never an empty history', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'transactions' ? { message: INTERNAL } : null));
    const response = await get(SUB_A);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('source_unavailable');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['code', 'error']);
    expect(text).not.toContain(INTERNAL);
  });
});
