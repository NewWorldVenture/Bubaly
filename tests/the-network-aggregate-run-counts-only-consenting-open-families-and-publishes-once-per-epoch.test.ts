// The Intelligence Network aggregation cron, driven through its real exported
// GET with the real cron-auth check, over the in-memory database. The core
// (lib/network/aggregate-server.ts runNetworkAggregation) runs for real: the
// consent read, the prune, the contribution reads and upserts, the publication
// claim, the launch gate and the epoch hold. Nothing here is a provider.
//
// Already covered elsewhere, and not repeated here:
//  - banding of one household's raw rows, granular scopes, the k-floor and
//    complementary suppression, called on the core directly:
//    tests/network-aggregate-server.test.ts
//  - a closed family stops contributing (core): tests/a-closed-family-is-left-alone-by-the-crons.test.ts
//  - noise drawn once per epoch, overlapping runs, withdrawal during a run:
//    tests/network-noise-is-drawn-once-per-epoch.test.ts,
//    tests/network-overlapping-runs-publish-once-per-epoch.test.ts,
//    tests/network-a-withdrawal-during-a-run-is-not-published.test.ts
//  - the route maps a core failure to a sanitized 502 (source text):
//    tests/cron-recovery-boundaries.test.ts
// What only this file proves is the route: its auth, its status and body over
// populated data, and that a non-consenting household reaches neither table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-09-07T08:00:00.000Z';
const NEXT_NIGHT = '2026-09-08T08:00:00.000Z';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const OFF = '00000000-0000-4000-8000-0000000000c1';
const CLOSED = '00000000-0000-4000-8000-0000000000d1';
const BY_CHILD = '00000000-0000-4000-8000-0000000000e1';
const NONE = '00000000-0000-4000-8000-0000000000f1';

const h = vi.hoisted(() => ({ db: null as unknown, serviceClientCalls: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => { h.serviceClientCalls++; return h.db; },
}));

const { GET } = await import('@/app/api/cron/network-aggregate/route');

let db: InMemorySupabase;
const req = (authorization?: string) => new Request('https://bubaly.test/api/cron/network-aggregate', {
  headers: authorization ? { authorization } : {},
}) as never;
const authorized = () => req(`Bearer ${SECRET}`);
const day = (offset: number) => new Date(Date.parse(NOW) + offset * 86_400_000).toISOString().slice(0, 10);
const contributionOf = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);
const fakeId = (prefix: string, i: number) => `00000000-0000-4000-8${prefix}-${String(i).padStart(12, '0')}`;

type Consent = 'on' | 'off' | 'none' | 'by-child';
/**
 * A household with a parent and a child, and `spend` of expenses in the last
 * four weeks. `consent`: 'on' (benchmarks, written by the parent), 'off'
 * (switched off), 'none' (never joined), 'by-child' (switched on by the child,
 * which 0353 no longer allows and the run does not honour).
 */
function household(id: string, opts: { consent?: Consent; spend?: number; closedAt?: string | null } = {}) {
  const consent = opts.consent ?? 'on';
  db.seed('families', [{ id, timezone: 'UTC', closed_at: opts.closedAt ?? null }]);
  db.seed('family_members', [
    { id: `${id}-p`, family_id: id, user_id: `${id}-pu`, role: 'parent', birthday: '1985-03-03', is_active: true },
    { id: `${id}-k`, family_id: id, user_id: `${id}-ku`, role: 'child', birthday: '2018-06-01', is_active: true },
  ]);
  const spend = opts.spend ?? 400;
  db.seed('transactions', [
    { family_id: id, amount: spend / 2, type: 'expense', date: day(-3) },
    { family_id: id, amount: spend / 2, type: 'expense', date: day(-20) },
  ]);
  db.seed('meal_plans', [{ family_id: id, meal_type: 'dinner', plan_date: day(1) }]);
  if (consent === 'none') return;
  db.seed('network_consent', [{
    family_id: id, enabled: consent !== 'off', scopes: { benchmarks: true },
    consented_by: consent === 'by-child' ? `${id}-ku` : `${id}-pu`,
  }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.serviceClientCalls = 0;
  db = createInMemorySupabase({
    uniques: {
      network_contributions: [['family_id']],
      network_aggregates: [['scope', 'cohort_key', 'metric', 'value']],
      app_settings: [['key']],
    },
  });
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** Two consenting households and every kind the run must leave out, each with a big spender's rows. */
function smallNetwork() {
  household(A, { spend: 400 });
  household(B, { spend: 8000 });
  household(OFF, { consent: 'off', spend: 1200 });
  household(CLOSED, { spend: 1200, closedAt: '2026-09-01T00:00:00.000Z' });
  household(BY_CHILD, { consent: 'by-child', spend: 1200 });
  household(NONE, { consent: 'none', spend: 1200 });
  // Rows stored by an earlier night, before these families left.
  db.seed('network_contributions', [OFF, CLOSED, BY_CHILD].map((family_id) => ({
    family_id, cohort_key: 'kids:6–9|size:1–2', metrics: { weekly_spend_band: '250–500' }, features: {}, scopes: { benchmarks: true },
  })));
}

describe('authorization, with the real cron-auth check', () => {
  it('API-3FFBC3414FDB JOB-6E85CF40F44B: no Authorization header answers 401 before any read', async () => {
    smallNetwork();
    db.log.length = 0;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'networkAggregate.unauthorized' });
    expect(h.serviceClientCalls).toBe(0);
    expect(db.log).toEqual([]);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: a wrong Bearer secret answers 401 before any read', async () => {
    const res = await GET(req('Bearer not-the-secret'));
    expect(res.status).toBe(401);
    expect(h.serviceClientCalls).toBe(0);
    expect(db.log).toEqual([]);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: the right secret runs the aggregation', async () => {
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, contributors: 0, aggregates: 0 });
    expect(h.serviceClientCalls).toBe(1);
  });
});

describe('a populated run below the launch gate', () => {
  it('API-3FFBC3414FDB JOB-6E85CF40F44B: contributes the two consenting open families only, prunes the ones that left, publishes nothing', async () => {
    smallNetwork();
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, contributors: 2, aggregates: 0 });
    expect(db.table('network_contributions').map((r) => r.family_id).sort()).toEqual([A, B].sort());
    expect(db.table('network_aggregates')).toEqual([]);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: never reads a household source row of a family that is not contributing', async () => {
    smallNetwork();
    const SOURCES = new Set(['meal_plans', 'teams', 'school_classes', 'chore_assignments', 'bedtime_routines', 'transactions', 'family_reminders', 'reminders']);
    const asked = new Set<string>();
    h.db = withFaults(db, (table, calls) => {
      if (SOURCES.has(table)) {
        for (const c of calls) if (c.method === 'in' && c.args[0] === 'family_id') for (const id of c.args[1] as string[]) asked.add(id);
      }
      return null;
    });
    expect((await GET(authorized())).status).toBe(200);
    expect([...asked].sort()).toEqual([A, B].sort());
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: each family\'s row holds its own bands and nothing of the other\'s', async () => {
    smallNetwork();
    await GET(authorized());
    const [a] = contributionOf(A);
    const [b] = contributionOf(B);
    expect((a.metrics as Record<string, string>).weekly_spend_band).toBe('100–250');
    expect((b.metrics as Record<string, string>).weekly_spend_band).toBe('1,000+');
    for (const [row, other] of [[a, B], [b, A]] as [Row, string][]) {
      expect(JSON.stringify(row)).not.toContain(other);
      // No raw amount, birthday or member id left the household.
      const shared = JSON.stringify({ cohort: row.cohort_key, features: row.features, metrics: row.metrics });
      for (const raw of ['4000', '200', '-p', '-k', '1985', '2018']) expect(shared).not.toContain(raw);
    }
  });
});

describe('the launch gate counts consenting open families only', () => {
  it('API-3FFBC3414FDB JOB-6E85CF40F44B: 99 consenting families and 40 that did not consent publish nothing', async () => {
    for (let i = 0; i < 99; i++) household(fakeId('001', i));
    for (let i = 0; i < 20; i++) household(fakeId('002', i), { consent: 'off', spend: 8000 });
    for (let i = 0; i < 10; i++) household(fakeId('003', i), { consent: 'by-child', spend: 8000 });
    for (let i = 0; i < 10; i++) household(fakeId('004', i), { spend: 8000, closedAt: '2026-09-01T00:00:00.000Z' });
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, contributors: 99, aggregates: 0 });
    expect(db.table('network_aggregates')).toEqual([]);
    expect(db.table('network_contributions')).toHaveLength(99);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: at 100 it publishes, and no non-consenting household is in any count', async () => {
    for (let i = 0; i < 100; i++) household(fakeId('001', i));
    // Forty households that did not consent, all in a band of their own: had
    // any of them been counted, "1,000+" would clear the k-floor of 20.
    for (let i = 0; i < 20; i++) household(fakeId('002', i), { consent: 'off', spend: 8000 });
    for (let i = 0; i < 10; i++) household(fakeId('003', i), { consent: 'by-child', spend: 8000 });
    for (let i = 0; i < 10; i++) household(fakeId('004', i), { spend: 8000, closedAt: '2026-09-01T00:00:00.000Z' });
    const res = await GET(authorized());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.contributors).toBe(100);
    const published = db.table('network_aggregates');
    expect(published.length).toBe(body.aggregates);
    expect(published.length).toBeGreaterThan(0);
    for (const r of published) expect(r.cohort_size, String(r.metric)).toBe(100);
    expect(published.some((r) => r.value === '1,000+')).toBe(false);
    expect(published.find((r) => r.metric === 'weekly_spend_band')?.value).toBe('100–250');
    expect(published.every((r) => r.computed_at === NOW)).toBe(true);
    // No family id or member id is on a published row.
    expect(JSON.stringify(published)).not.toContain('00000000-0000-4000-8');
  });
});

describe('idempotence and failure', () => {
  it('API-3FFBC3414FDB JOB-6E85CF40F44B: the next night of the same epoch holds the published figures and adds no row', async () => {
    for (let i = 0; i < 100; i++) household(fakeId('001', i));
    const first = await (await GET(authorized())).json();
    const figures = () => db.table('network_aggregates')
      .map((r) => JSON.stringify([r.scope, r.cohort_key, r.metric, r.value, r.count, r.cohort_size])).sort();
    const published = figures();
    const contributions = JSON.stringify(db.table('network_contributions').map((r) => [r.family_id, r.cohort_key, r.metrics]));
    // A family joins mid-epoch: it contributes, but the figures do not move.
    household(fakeId('005', 1), { spend: 8000 });
    vi.setSystemTime(new Date(NEXT_NIGHT));
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, contributors: 101, aggregates: first.aggregates });
    expect(figures()).toEqual(published);
    expect(db.table('network_aggregates').every((r) => r.computed_at === NEXT_NIGHT)).toBe(true);
    expect(JSON.stringify(db.table('network_contributions').filter((r) => r.family_id !== fakeId('005', 1))
      .map((r) => [r.family_id, r.cohort_key, r.metrics]))).toBe(contributions);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: a failed consent read answers 502 with a sanitized error and changes nothing', async () => {
    smallNetwork();
    h.db = withFaults(db, (table) => (table === 'network_consent' ? { message: 'connection reset' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, contributors: 0, aggregates: 0, error: 'networkAggregate.networkAggregationFailed' });
    expect(db.table('network_contributions').map((r) => r.family_id).sort()).toEqual([OFF, CLOSED, BY_CHILD].sort());
    expect(db.table('network_aggregates')).toEqual([]);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: a failed household source read answers 502 and writes no contribution, after still forgetting the families that left', async () => {
    smallNetwork();
    h.db = withFaults(db, (table) => (table === 'transactions' ? { message: 'connection reset' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, contributors: 0, aggregates: 0 });
    expect(db.table('network_contributions')).toEqual([]);
  });

  it('API-3FFBC3414FDB JOB-6E85CF40F44B: one family\'s refused write fails the night (502) while the other family is still stored', async () => {
    smallNetwork();
    h.db = withFaults(db, (table, calls) => (table === 'network_contributions'
      && calls.some((c) => c.method === 'upsert' && (c.args[0] as Row).family_id === A) ? { message: 'permission denied' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, contributors: 1, aggregates: 0, error: 'networkAggregate.networkAggregationFailed' });
    expect(contributionOf(A)).toEqual([]);
    expect(contributionOf(B)).toHaveLength(1);
    expect(db.table('network_aggregates')).toEqual([]);
  });
});
