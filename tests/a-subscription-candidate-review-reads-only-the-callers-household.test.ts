// API-F571E7B557A1 — GET /api/subscriptions/candidates, driven end to end.
//
// tests/subscription-candidates-api.test.ts pins this handler against a scripted
// builder: the filters it passes, row caps, currency handling and the response
// shape for each scripted read. Here the real handler runs over the in-memory
// database with the real getUserContext and plan resolver, seeded with two
// households whose recorded charges look alike, so the cases show which rows a
// real request reads and returns — and that a read-only review writes nothing.
//
// Isolation note: the in-memory database applies no RLS. These cases prove the
// route's own `family_id` filters and its post-read scope checks; in
// production the cookie client's RLS is a second boundary on top.
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

import { GET } from '@/app/api/subscriptions/candidates/route';

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
const INTERNAL = 'relation "transactions" internal detail 0xDEADBEEF';
const SOURCE_TABLES = ['transactions', 'subscriptions_tracked', 'financial_accounts'];

function build(userId: string | null, opts: { plan?: string | null; tiers?: Record<string, string>; superAdmin?: boolean; trackedInA?: string[] } = {}) {
  const db = createInMemorySupabase({ userId, rpc: { is_super_admin: () => opts.superAdmin === true } });
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
  const series = (family: string, prefix: string, name: string, amount: number, account: string, member: string) =>
    ['2026-06-15', '2026-07-15', '2026-08-15'].map((date, i) => ({
      id: `${prefix}-${i}`, family_id: family, name, amount, type: 'expense', date, category: 'Subscriptions', account_id: account, member_id: member,
    }));
  db.seed('transactions', [
    ...series(FAMILY_A, 'txn-a', 'Example Media', 15, ACCOUNT_A, memberOf('parent')),
    ...series(FAMILY_B, 'txn-b', 'Example Stream B', 22, ACCOUNT_B, MEMBER_B),
  ]);
  db.seed('subscriptions_tracked', [
    ...(opts.trackedInA ?? []).map((name, i) => ({ id: `a7000000-0000-4000-8000-00000000000${i + 1}`, family_id: FAMILY_A, name, note: null })),
    // B tracks A's charge name: it must not suppress A's candidate.
    { id: 'b7000000-0000-4000-8000-000000000001', family_id: FAMILY_B, name: 'Example Media', note: null },
  ]);
  h.db = db;
  return db;
}

const snapshot = (db: InMemorySupabase) => JSON.stringify(['transactions', 'subscriptions_tracked', 'financial_accounts'].map((t) => db.table(t)));
const touched = (db: InMemorySupabase) => db.log.map((entry) => entry.table).filter((t) => SOURCE_TABLES.includes(t));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/subscriptions/candidates over a two-household database', () => {
  it('API-F571E7B557A1 signed-out: 401 and no household source is read', async () => {
    const db = build(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('signed_out');
    expect(touched(db)).toEqual([]);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('API-F571E7B557A1 a %s of household A is refused 403 before any money source is read', async (role) => {
    const db = build(userOf(role));
    const response = await GET();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('role_required');
    expect(touched(db)).toEqual([]);
  });

  it.each(['parent', 'adult'] as const)("API-F571E7B557A1 a %s sees household A's recurring charge with its evidence, and nothing of household B", async (role) => {
    const db = build(userOf(role));
    const before = snapshot(db);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.familyId).toBe(FAMILY_A);
    expect(body.context).toEqual({ familyId: FAMILY_A, userId: userOf(role), memberId: memberOf(role), role, active: true });
    expect(body.recordsRead).toBe(3);
    expect(body.unsupportedCurrencyRecords).toBe(0);
    expect(body.candidates.map((c: Row) => [c.name, c.amountCents, c.currency, c.cadence])).toEqual([['Example Media', 1500, 'USD', 'monthly']]);
    expect(body.candidates[0].evidence.map((e: Row) => e.recordId).sort()).toEqual(['txn-a-0', 'txn-a-1', 'txn-a-2']);
    const text = JSON.stringify(body);
    for (const leak of [FAMILY_B, 'Example Stream B', 'txn-b-', ACCOUNT_B, MEMBER_B]) expect(text).not.toContain(leak);
    expect(snapshot(db)).toBe(before);
  });

  it("API-F571E7B557A1 a charge household A already tracks is not suggested again; B's tracked list does not suppress A's", async () => {
    build(userOf('parent'), { trackedInA: ['Example Media'] });
    const suppressed = await (await GET()).json();
    expect(suppressed.candidates).toEqual([]);
    expect(suppressed.recordsRead).toBe(3);
  });

  it("API-F571E7B557A1 a parent of household B gets only B's charge", async () => {
    const db = build(USER_B);
    const body = await (await GET()).json();
    expect(body.familyId).toBe(FAMILY_B);
    expect(body.candidates.map((c: Row) => c.name)).toEqual(['Example Stream B']);
    expect(JSON.stringify(body)).not.toContain('txn-a-');
    expect(touched(db).length).toBeGreaterThan(0);
  });

  it('API-F571E7B557A1 a family below the subscription-tracking tier is refused 403; the feature switched off is 404; a super admin passes', async () => {
    build(userOf('parent'), { plan: null });
    const locked = await GET();
    expect(locked.status).toBe(403);
    expect((await locked.json()).code).toBe('plan_required');
    build(userOf('parent'), { tiers: { 'subscription-tracking': 'off' } });
    const off = await GET();
    expect(off.status).toBe(404);
    expect((await off.json()).code).toBe('feature_off');
    build(userOf('parent'), { plan: null, superAdmin: true });
    expect((await GET()).status).toBe(200);
  });

  it('API-F571E7B557A1 a failed expense read is 503 source_unavailable, never an empty candidate list, and carries no internal text', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'transactions' ? { message: INTERNAL } : null));
    const response = await GET();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('source_unavailable');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['code', 'error']);
    expect(text).not.toContain(INTERNAL);
  });

  it('API-F571E7B557A1 a failed account-currency read is 503, not charges of unknown currency', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'financial_accounts' ? { message: INTERNAL } : null));
    const response = await GET();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('source_unavailable');
    expect(text).not.toContain(INTERNAL);
  });
});
