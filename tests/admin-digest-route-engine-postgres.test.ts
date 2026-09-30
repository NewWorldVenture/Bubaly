// /api/cron/admin-digest on the delivery engine, with the REAL 0471 store: the route,
// the PostgreSQL adapter and migration 0471 on a disposable local database, reached
// through the same `rpc` call shape the Supabase service client uses.
//
// Opt-in, like admin-digest-delivery-postgres.test.ts: DIGEST_DELIVERY_PG=1 and a local
// cluster (docs/audit/verify-pg.sh). DIGEST_DELIVERY_PG_RESTART_CMD adds the restart case; with it set,
// run the PostgreSQL files with --no-file-parallelism, because a restart ends every connection to the
// shared cluster, including another file's.
// Fake: the notification and super-admin tables (in memory), the clock (Date, which is
// also pinned into the database per call) and Resend at the HTTP boundary. Nothing is
// sent; nothing touches a shared or production database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { createPgFixture, pgFixtureEnabled, type PgFixture } from './helpers/digest-delivery-postgres';
import { createFakeResendHttp } from './helpers/fake-resend-http';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const CRON = 'test-cron-secret-not-real';
const TABLE_ADMIN = 'table-admin@example.test';
const OCC = 'admin-digest:2026-09-30T12:30:00.000Z';
const everyone = () => [...new Set([...superAdminEmails(), TABLE_ADMIN])];
const RESTART = process.env.DIGEST_DELIVERY_PG_RESTART_CMD;

describe.skipIf(!pgFixtureEnabled)('the admin digest route on PostgreSQL (0471, disposable database)', () => {
  let fx: PgFixture;
  let db: InMemorySupabase;
  let resend: ReturnType<typeof createFakeResendHttp>;
  const saved = { ...process.env };

  beforeAll(async () => { fx = await createPgFixture(); }, 60_000);
  afterAll(async () => { await fx?.drop(); }, 60_000);
  beforeEach(async () => {
    await fx.reset();
    vi.useFakeTimers({ toFake: ['Date'] });
    process.env.CRON_SECRET = CRON;
    process.env.RESEND_API_KEY = 're_synthetic_not_real';
    process.env.SUPER_ADMIN_EMAILS = 'env-admin@example.test';
    process.env.ADMIN_DIGEST_DELIVERY_ENGINE = '1';
    db = createInMemorySupabase();
    db.seed('super_admins', [{ email: TABLE_ADMIN }]);
    db.seed('admin_notifications', [{ id: 'n-1', kind: 'family_signup', title: 'Family A joined', created_at: '2026-09-30T09:00:00.000Z' }]);
    // The service client: tables from memory, `rpc` to the real functions as service_role, at the test's clock.
    const pg = fx.rpc(() => new Date());
    state.db = {
      from: db.from.bind(db),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        try { return { data: await pg(fn, args), error: null }; } catch (e) { return { data: null, error: { message: String(e) } }; }
      },
    };
    resend = createFakeResendHttp();
    vi.stubGlobal('fetch', resend.fetchImpl);
  });
  afterEach(() => {
    expect(resend.stray).toEqual([]);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = { ...saved };
  });

  const call = () => GET(new Request('https://bubaly.test/api/cron/admin-digest', { headers: { authorization: `Bearer ${CRON}` } }) as never);
  async function tick(at: string) {
    vi.setSystemTime(new Date(at));
    const res = await call();
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  const rows = () => fx.sql(`select status || ':' || attempts || ':' || fence from public.admin_digest_deliveries where occurrence_id = '${OCC}' order by recipient_key;`);

  it('each admin once; the database holds one accepted receipt per admin; a later tick sends nothing', async () => {
    expect(await tick('2026-09-30T12:31:00Z')).toMatchObject({ status: 200, body: { ok: true, occurrenceId: OCC, complete: true } });
    expect((await rows()).split('\n')).toEqual(everyone().map(() => 'accepted:1:1'));
    expect(await tick('2026-09-30T18:48:00Z')).toMatchObject({ status: 200, body: { ok: true, created: false, sentThisRun: 0, planMismatch: null } });
    for (const a of everyone()) expect(resend.deliveredTo(a)).toBe(1);
    expect(resend.requests).toHaveLength(everyone().length);
  }, 60_000);

  it('two route invocations at once, on real row locks: each admin once', async () => {
    vi.setSystemTime(new Date('2026-09-30T12:31:00Z'));
    await Promise.all([call(), call(), call()]);
    for (const a of everyone()) expect(resend.deliveredTo(a)).toBe(1);
    expect(await tick('2026-09-30T12:40:00Z')).toMatchObject({ body: { ok: true, complete: true, sentThisRun: 0 } });
    expect(resend.inbox).toHaveLength(everyone().length);
  }, 60_000);

  it('accepted but answered 500: the retry, from the database alone, reuses the key and bytes and delivers nothing new', async () => {
    resend.script = ({ to, n }) => (to === TABLE_ADMIN && n === 1 ? 'accept_then_500' : 'accept');
    expect((await tick('2026-09-30T12:31:00Z')).status).toBe(502);
    expect(await fx.sql(`select status || ':' || ambiguous from public.admin_digest_deliveries where occurrence_id = '${OCC}' and status <> 'accepted';`)).toBe('unknown:true');
    expect(await tick('2026-09-30T12:36:00Z')).toMatchObject({ status: 200, body: { ok: true, complete: true } });
    const toTable = resend.requests.filter((q) => q.to === TABLE_ADMIN);
    expect(toTable).toHaveLength(2);
    expect(new Set(toTable.map((q) => `${q.key}|${q.body}`)).size).toBe(1);
    expect(resend.deliveredTo(TABLE_ADMIN)).toBe(1);
  }, 60_000);

  it.skipIf(!RESTART)('a database restart between a failed run and its retry: the retry still delivers once', async () => {
    resend.script = ({ to, n }) => (to === TABLE_ADMIN && n === 1 ? 'accept_then_500' : 'accept');
    expect((await tick('2026-09-30T12:31:00Z')).status).toBe(502);
    execSync(RESTART!, { stdio: 'ignore', timeout: 60_000 });
    expect(await tick('2026-09-30T12:36:00Z')).toMatchObject({ status: 200, body: { ok: true, complete: true } });
    expect(resend.deliveredTo(TABLE_ADMIN)).toBe(1);
  }, 120_000);

  it('an address the engine cannot use: nothing reaches the database or Resend', async () => {
    db.seed('super_admins', [{ email: 'Ops <ops@example.test>' }]);
    expect(await tick('2026-09-30T12:31:00Z')).toMatchObject({ status: 502, body: { reason: 'plan_refused' } });
    expect(await fx.sql('select count(*) from public.admin_digest_occurrences;')).toBe('0');
    expect(resend.requests).toEqual([]);
  }, 60_000);
});
