// The model-refresh cron, driven through its real exported GET with the real
// cron-auth check, over the in-memory database with two open households to
// model and the rows it must leave alone: a closed family, a family refreshed
// an hour ago, and a member who left one household. The twin projection and
// prep-plan generation are the REAL service cores, so what this reads back is
// what the cron itself wrote (graph_entities, prep_plans, family_model_dirty).
// Only signal detection is a recording stand-in: it reads the Reminders
// module's table, and its failure is non-fatal by the route's own comment.
//
// Already covered elsewhere, and not repeated here:
//  - budget, per-family timeout and slot rotation:
//    tests/model-refresh-is-budgeted-bounded-and-rotated.test.ts
//  - a closed family is not projected (with auth mocked away):
//    tests/a-closed-family-is-left-alone-by-the-crons.test.ts
//  - prep plans keep a dismissal, and are dated on the family's day:
//    tests/a-dismissed-plan-stays-dismissed-when-plans-are-regenerated.test.ts,
//    tests/prep-plans-are-the-familys-day.test.ts
//  - source-text checks that failures map to 502:
//    tests/cron-batch-failure-status.test.ts, tests/cron-return-reminders-boundary.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-09-21T04:00:00.000Z';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const CLOSED = '00000000-0000-4000-8000-0000000000c1';
const FRESH = '00000000-0000-4000-8000-0000000000d1';
const ALL = [A, B, CLOSED, FRESH];

const h = vi.hoisted(() => ({
  db: null as unknown,
  serviceClientCalls: 0,
  signalsFor: [] as string[],
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => { h.serviceClientCalls++; return h.db; },
}));
vi.mock('@/lib/intelligence/hard-signals-server', () => ({
  runSignalDetection: async (_db: unknown, familyId: string) => { h.signalsFor.push(familyId); return {}; },
}));

const { GET } = await import('@/app/api/cron/model-refresh/route');

let db: InMemorySupabase;
const req = (authorization?: string) => new Request('https://bubaly.test/api/cron/model-refresh', {
  headers: authorization ? { authorization } : {},
}) as never;
const authorized = () => req(`Bearer ${SECRET}`);
const rows = (table: string, familyId: string) => db.table(table).filter((r) => r.family_id === familyId);
const snapshot = () => JSON.stringify(['graph_entities', 'graph_edges', 'prep_plans', 'prep_plan_steps', 'family_model_dirty']
  .map((t) => db.table(t).map((r: Row) => ({ ...r }))));

function household(familyId: string, label: string, closedAt: string | null = null) {
  db.seed('families', [{ id: familyId, timezone: 'UTC', closed_at: closedAt }]);
  db.seed('family_members', [
    { id: `${label}-parent`, family_id: familyId, display_name: `${label} Parent`, birthday: null, is_active: true },
    { id: `${label}-kid`, family_id: familyId, display_name: `${label} Kid`, birthday: '2016-10-15', is_active: true },
  ]);
  db.seed('vacations', [{ id: `${label}-trip`, family_id: familyId, title: `${label} Trip`, start_date: '2026-10-05' }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.serviceClientCalls = 0;
  h.signalsFor = [];
  db = createInMemorySupabase({
    uniques: {
      family_model_dirty: [['family_id']],
      graph_entities: [['family_id', 'ref_table', 'ref_id']],
      graph_edges: [['family_id', 'source_id', 'target_id', 'relation']],
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    defaults: { graph_entities: { attributes: {} }, graph_edges: { attributes: {}, weight: 1 }, prep_plans: { status: 'active' } },
  });
  h.db = db;
  household(A, 'Alpha');
  household(B, 'Bravo');
  household(CLOSED, 'Closed', '2026-09-01T00:00:00.000Z');
  household(FRESH, 'Fresh');
  // Alpha's member who left the household: not modelled, no birthday plan.
  db.seed('family_members', [{ id: 'Alpha-left', family_id: A, display_name: 'Alpha Left', birthday: '2014-10-01', is_active: false }]);
  // Refreshed an hour ago and not dirty since: inside the six-hour TTL.
  db.seed('family_model_dirty', [{ family_id: FRESH, dirty: false, refreshed_at: '2026-09-21T03:00:00.000Z' }]);
  // Bravo was refreshed yesterday but a source change marked it dirty.
  db.seed('family_model_dirty', [{ family_id: B, dirty: true, refreshed_at: '2026-09-20T16:00:00.000Z' }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization, with the real cron-auth check', () => {
  it('API-AAC0F7C0EF4E JOB-D3457248E130: no Authorization header answers 401 before any read', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'modelRefresh.unauthorized' });
    expect(h.serviceClientCalls).toBe(0);
    expect(db.log).toEqual([]);
    expect(h.signalsFor).toEqual([]);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: a wrong Bearer secret answers 401 before any read', async () => {
    const res = await GET(req('Bearer not-the-secret'));
    expect(res.status).toBe(401);
    expect(h.serviceClientCalls).toBe(0);
    expect(db.log).toEqual([]);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: the right secret runs the sweep', async () => {
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(h.serviceClientCalls).toBe(1);
    expect(db.log.length).toBeGreaterThan(0);
  });
});

describe('a populated run', () => {
  it('API-AAC0F7C0EF4E JOB-D3457248E130: models the two due open families, skips the fresh one and never touches the closed one', async () => {
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, families: 3, refreshed: 2, skipped: 1, failures: 0, timedOut: 0, unreached: 0 });

    for (const fam of [A, B]) {
      expect(rows('graph_entities', fam).length, fam).toBeGreaterThan(0);
      expect(rows('prep_plans', fam).length, fam).toBeGreaterThan(0);
      expect(rows('family_model_dirty', fam), fam).toEqual([expect.objectContaining({ dirty: false, refreshed_at: NOW })]);
    }
    for (const fam of [CLOSED, FRESH]) {
      expect(rows('graph_entities', fam), fam).toEqual([]);
      expect(rows('prep_plans', fam), fam).toEqual([]);
    }
    expect(rows('family_model_dirty', CLOSED)).toEqual([]);
    expect(rows('family_model_dirty', FRESH)).toEqual([expect.objectContaining({ refreshed_at: '2026-09-21T03:00:00.000Z' })]);
    expect(new Set(h.signalsFor)).toEqual(new Set([A, B]));
    // The member who left is neither a graph node nor planned a birthday.
    expect(db.table('graph_entities').some((r) => r.ref_id === 'Alpha-left')).toBe(false);
    expect(db.table('prep_plans').some((r) => r.signal_id === 'Alpha-left')).toBe(false);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: each family\'s graph and plans are built only from its own rows', async () => {
    await GET(authorized());
    const own: Record<string, 'Alpha' | 'Bravo'> = { [A]: 'Alpha', [B]: 'Bravo' };
    for (const fam of [A, B]) {
      const label = own[fam];
      const other = label === 'Alpha' ? 'Bravo' : 'Alpha';
      const entities = rows('graph_entities', fam);
      expect(entities.map((r) => r.ref_id).sort()).toEqual([`${label}-kid`, `${label}-parent`].sort());
      expect(JSON.stringify(entities)).not.toContain(other);
      const plans = rows('prep_plans', fam);
      expect(plans.map((r) => r.signal_id).sort()).toEqual([`${label}-kid`, `${label}-trip`].sort());
      expect(JSON.stringify(plans)).not.toContain(other);
      const planIds = new Set(plans.map((p) => p.id));
      expect(rows('prep_plan_steps', fam).every((s) => planIds.has(s.plan_id)), fam).toBe(true);
    }
    // Nothing was written under a family id the run did not own.
    const families = new Set(['graph_entities', 'graph_edges', 'prep_plans', 'prep_plan_steps']
      .flatMap((t) => db.table(t).map((r) => r.family_id)));
    expect(families).toEqual(new Set([A, B]));
  });
});

describe('idempotence and failure', () => {
  it('API-AAC0F7C0EF4E JOB-D3457248E130: a second run at the same time skips every family and writes nothing', async () => {
    expect((await GET(authorized())).status).toBe(200);
    const after = snapshot();
    h.signalsFor = [];
    const res = await GET(authorized());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, families: 3, refreshed: 0, skipped: 3, failures: 0, timedOut: 0, unreached: 0 });
    expect(snapshot()).toBe(after);
    expect(h.signalsFor).toEqual([]);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: a failed dirty-state read answers 500 and refreshes nobody', async () => {
    h.db = withFaults(db, (table) => (table === 'family_model_dirty' ? { message: 'connection reset' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'modelRefresh.modelRefreshCronFailed' });
    expect(db.table('graph_entities')).toEqual([]);
    expect(db.table('prep_plans')).toEqual([]);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: a failed families read answers 500, not an empty success', async () => {
    h.db = withFaults(db, (table) => (table === 'families' ? { message: 'connection reset' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(500);
    expect(db.table('graph_entities')).toEqual([]);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: one family\'s failed read is its failure (502), stays due, and the other family is still refreshed', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'vacations'
      && calls.some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === A) ? { message: 'connection reset' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, families: 3, refreshed: 1, skipped: 1, failures: 1 });
    // Alpha's refresh did not complete, so its dirty state is not cleared.
    expect(rows('family_model_dirty', A)).toEqual([]);
    expect(rows('prep_plans', A)).toEqual([]);
    // Bravo went on.
    expect(rows('family_model_dirty', B)).toEqual([expect.objectContaining({ dirty: false, refreshed_at: NOW })]);
    expect(rows('prep_plans', B).length).toBeGreaterThan(0);
  });

  it('API-AAC0F7C0EF4E JOB-D3457248E130: a refused dirty-state write is a failure (502), not a refresh', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'family_model_dirty'
      && calls.some((c) => c.method === 'upsert') ? { message: 'permission denied' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, refreshed: 0, failures: 2, skipped: 1 });
    expect(rows('family_model_dirty', B)).toEqual([expect.objectContaining({ dirty: true })]);
  });
});
