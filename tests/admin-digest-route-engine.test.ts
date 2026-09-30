// /api/cron/admin-digest on the per-recipient delivery engine, end to end and synthetic.
//
// Real: the route handler, cron auth, the default-off flag, the slot's feed read
// (readAll), readSuperAdminRecipients (#685), recipient normalisation, rendering,
// the engine, and the Resend adapter down to `fetch`.
// Fake: the database tables (tests/helpers/in-memory-supabase), the delivery store
// (the in-memory twin of 0471 that the engine's contract suite pins; the PostgreSQL
// run of the same route is admin-digest-route-engine-postgres.test.ts), the clock
// (Date only) and Resend (tests/helpers/fake-resend-http, at the HTTP boundary).
// Nothing is sent and no migration is applied.
//
// What these tests do NOT show: behaviour on the production database (0471 is not
// applied there), a real provider, or a real scheduler. Duplicate delivery is not
// claimed solved in production by them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idempotencyKeyFor, recipientKeyOf } from '@/lib/admin/digest-delivery';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { MemoryDigestDeliveryStore } from './helpers/digest-delivery-fakes';
import { createFakeResendHttp } from './helpers/fake-resend-http';

const state = vi.hoisted(() => ({ db: null as unknown, store: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/admin/digest-delivery-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/digest-delivery-store')>()),
  createPostgresDigestDeliveryStore: () => state.store,
}));

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const CRON = 'test-cron-secret-not-real';
const ENV_ADMIN = 'env-admin@example.test';
const TABLE_ADMIN = 'table-admin@example.test';
const SLOT = '2026-09-30T12:30:00.000Z';
const OCC = `admin-digest:${SLOT}`;

let db: InMemorySupabase;
let store: MemoryDigestDeliveryStore;
let resend: ReturnType<typeof createFakeResendHttp>;

function happen(at: string, title: string) {
  db.seed('admin_notifications', [{ id: `n-${title}`, kind: 'family_signup', title, created_at: new Date(at).toISOString() }]);
}
async function tick(at: string) {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request('https://bubaly.test/api/cron/admin-digest', { headers: { authorization: `Bearer ${CRON}` } }) as never);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}
const keyFor = (address: string) => idempotencyKeyFor(OCC, recipientKeyOf(address));
/** Everyone the digest goes to: the code/env allowlist (built-in + SUPER_ADMIN_EMAILS) ∪ the table. */
const everyone = () => [...new Set([...superAdminEmails(), TABLE_ADMIN])];

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  process.env.CRON_SECRET = CRON;
  process.env.RESEND_API_KEY = 're_synthetic_not_real';
  process.env.SUPER_ADMIN_EMAILS = ENV_ADMIN;
  process.env.ADMIN_DIGEST_DELIVERY_ENGINE = '1';
  delete process.env.EMAIL_FROM;
  db = createInMemorySupabase();
  db.seed('super_admins', [{ email: TABLE_ADMIN }]);
  state.db = db;
  store = new MemoryDigestDeliveryStore(() => new Date());
  state.store = store;
  resend = createFakeResendHttp();
  vi.stubGlobal('fetch', resend.fetchImpl);
  happen('2026-09-30T09:00:00Z', 'Family A joined');
});
afterEach(() => {
  expect(resend.stray, 'no request left for any other host').toEqual([]);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...saved };
});

describe('the flag', () => {
  it('unset: the route behaves exactly as before; the delivery store is never touched and no key is sent', async () => {
    delete process.env.ADMIN_DIGEST_DELIVERY_ENGINE;
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r.status).toBe(200);
    expect(store.calls).toEqual([]);
    expect(resend.requests).toHaveLength(everyone().length);
    expect(resend.requests.every((q) => q.key === null)).toBe(true);
  });

  it('any value but "1" is off', async () => {
    process.env.ADMIN_DIGEST_DELIVERY_ENGINE = 'true';
    await tick('2026-09-30T12:31:00Z');
    expect(store.calls).toEqual([]);
  });

  it('on, without a Resend key: nothing is frozen and nothing is sent, and the run is not reported as done', async () => {
    delete process.env.RESEND_API_KEY;
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r).toMatchObject({ status: 503, body: { ok: false, reason: 'email_provider_not_configured' } });
    expect(store.calls).toEqual([]);
    expect(resend.requests).toEqual([]);
  });

  it('on, without cron authorization: 401, and nothing is read, frozen or sent', async () => {
    vi.setSystemTime(new Date('2026-09-30T12:31:00Z'));
    const res = await GET(new Request('https://bubaly.test/api/cron/admin-digest') as never);
    expect(res.status).toBe(401);
    expect(store.calls).toEqual([]);
    expect(resend.requests).toEqual([]);
  });
});

describe('one slot, each admin once', () => {
  it('delivers once to each admin, under the engine\'s key, with the stored bytes; the answer names no address', async () => {
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r.status).toBe(200);
    const n = everyone().length;
    expect(r.body).toMatchObject({ ok: true, occurrenceId: OCC, created: true, complete: true, recipients: n, sentThisRun: n, statuses: { accepted: n } });
    expect(r.text).not.toMatch(/@/);
    for (const a of everyone()) expect(resend.deliveredTo(a)).toBe(1);
    expect(resend.requests.map((q) => q.key).sort()).toEqual(everyone().map(keyFor).sort());
    const stored = await store.load(OCC);
    for (const q of resend.requests) expect(stored!.deliveries.find((d) => d.idempotencyKey === q.key)!.payloadJson).toBe(q.body);
  });

  it('a late tick, and a second scheduler, for the same slot send nothing more', async () => {
    await tick('2026-09-30T12:31:00Z');
    const late = await tick('2026-09-30T18:48:37Z'); // a GitHub dispatch 6 h late
    const early = await tick('2026-10-01T12:29:59Z'); // still the same slot
    // The slot, not the clock, labels the digest: a later tick renders the same bytes, so nothing differs.
    for (const r of [late, early]) expect(r).toMatchObject({ status: 200, body: { ok: true, occurrenceId: OCC, created: false, sentThisRun: 0, planMismatch: null } });
    expect(resend.requests).toHaveLength(everyone().length);
  });

  it('two route invocations at once (Vercel and the GitHub dispatcher): each admin once', async () => {
    vi.setSystemTime(new Date('2026-09-30T12:31:00Z'));
    const call = () => GET(new Request('https://bubaly.test/api/cron/admin-digest', { headers: { authorization: `Bearer ${CRON}` } }) as never);
    const results = await Promise.all([call(), call()]);
    for (const a of everyone()) expect(resend.deliveredTo(a)).toBe(1);
    // The loser may see leased rows and answer non-2xx; a later tick settles to complete with nothing new.
    expect(results.some((r) => r.status === 200)).toBe(true);
    const after = await tick('2026-09-30T12:40:00Z');
    expect(after.body).toMatchObject({ ok: true, complete: true, sentThisRun: 0 });
    expect(resend.inbox).toHaveLength(everyone().length);
  });

  it('the next slot is a new digest, and activity after a slot is in the next one only', async () => {
    happen('2026-09-30T12:45:00Z', 'Family B joined after the slot');
    await tick('2026-09-30T12:31:00Z');
    expect(resend.inbox.every((m) => !m.body.includes('Family B joined after the slot'))).toBe(true);
    const next = await tick('2026-10-01T12:31:00Z');
    expect(next.body).toMatchObject({ ok: true, occurrenceId: 'admin-digest:2026-10-01T12:30:00.000Z', created: true });
    const second = resend.inbox.slice(everyone().length);
    expect(second).toHaveLength(everyone().length);
    expect(second.every((m) => m.body.includes('Family B joined after the slot') && !m.body.includes('Family A joined'))).toBe(true);
  });

  it('a slot with no activity freezes nothing and sends nothing', async () => {
    const r = await tick('2026-10-02T12:31:00Z'); // window 10-01 12:30 → 10-02 12:30 is empty
    expect(r).toMatchObject({ status: 200, body: { ok: true, sent: 0, reason: 'no activity in the window' } });
    expect(store.calls).toEqual([]);
    expect(resend.requests).toEqual([]);
  });
});

describe('the slot\'s feed is read so that no row is counted twice (review P2)', () => {
  // 1,001 signups plus the suite's "Family A": 1,002 rows inside the window, so two pages. Between page one
  // and page two, one paid-plan row becomes visible (a transaction that began before the slot and commits
  // during the read). OFFSET paging would read a boundary signup twice and freeze "1003 new families".
  // Keyset paging never re-reads a row.
  function feedWithLateRow(lateAt: string) {
    db.seed('admin_notifications', Array.from({ length: 1001 }, (_, i) => ({
      id: `n-${String(i).padStart(5, '0')}`, kind: 'family_signup', title: `Family ${i}`,
      created_at: new Date(Date.parse('2026-09-30T00:00:00Z') + i * 1000).toISOString(),
    })));
    const from = db.from.bind(db);
    let pages = 0;
    state.db = {
      from(table: string) {
        const qb = from(table) as unknown as { then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown> };
        if (table !== 'admin_notifications') return qb;
        const then = qb.then.bind(qb);
        qb.then = (f, r) => then((v) => {
          pages += 1;
          if (pages === 1) db.seed('admin_notifications', [{ id: 'n-late', kind: 'subscription', title: 'Paid plan', created_at: lateAt }]);
          return v;
        }).then(f, r);
        return qb;
      },
    };
  }
  const subjects = () => resend.inbox.map((m) => (JSON.parse(m.body) as { subject: string }).subject);

  it('a row that becomes visible ahead of the page boundary is not counted, and no signup is counted twice', async () => {
    feedWithLateRow('2026-09-30T10:00:00.000Z'); // newer than every signup: sorts ahead of page one's end
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1002, headline: '1002 new families.' });
    expect(subjects().length).toBe(everyone().length);
    expect(subjects().every((s) => s.endsWith('— 1002 new families.'))).toBe(true);
  });

  it('control: a row that becomes visible behind the cursor is counted once (the other coherent outcome)', async () => {
    feedWithLateRow('2026-09-29T23:00:00.000Z'); // older than every signup, still inside the window
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r.body).toMatchObject({ total: 1003 });
    expect(String(r.body.headline)).toMatch(/1 new paid plan/);
    expect(String(r.body.headline)).toMatch(/1002 new families/);
  });
});

describe('failures and retries', () => {
  it('accepted but answered 500: the run is not done; the retry reuses the key and bytes and gets the original message back', async () => {
    resend.script = ({ to, n }) => (to === ENV_ADMIN && n === 1 ? 'accept_then_500' : 'accept');
    const first = await tick('2026-09-30T12:31:00Z');
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ ok: false, complete: false, statuses: { accepted: everyone().length - 1, unknown: 1 } });
    const retry = await tick('2026-09-30T12:36:00Z');
    expect(retry).toMatchObject({ status: 200, body: { ok: true, complete: true } });
    const toEnv = resend.requests.filter((q) => q.to === ENV_ADMIN);
    expect(toEnv).toHaveLength(2);
    expect(new Set(toEnv.map((q) => `${q.key}|${q.body}`)).size).toBe(1);
    expect(resend.deliveredTo(ENV_ADMIN)).toBe(1);
  });

  it('a request lost before it arrived is retried under the same key and delivered once', async () => {
    resend.script = ({ to, n }) => (to === TABLE_ADMIN && n === 1 ? 'lose_before_arrival' : 'accept');
    expect((await tick('2026-09-30T12:31:00Z')).status).toBe(502);
    expect((await tick('2026-09-30T12:36:00Z')).status).toBe(200);
    expect(resend.deliveredTo(TABLE_ADMIN)).toBe(1);
  });

  it('the receipt write fails after Resend accepted (a crash between the two): the next run, after the lease, is answered from the key', async () => {
    let failOnce = true;
    store.hooks.push((method, phase, key) => {
      if (failOnce && method === 'complete' && phase === 'before' && key === recipientKeyOf(ENV_ADMIN)) { failOnce = false; throw new Error('synthetic storage failure'); }
    });
    const first = await tick('2026-09-30T12:31:00Z');
    expect(first.body).toMatchObject({ ok: false, storageErrors: 1 });
    const tooSoon = await tick('2026-09-30T12:33:00Z'); // the lease (5 min) still holds the row
    expect(tooSoon.body).toMatchObject({ ok: false, refused: 1 });
    const after = await tick('2026-09-30T12:37:00Z');
    expect(after).toMatchObject({ status: 200, body: { ok: true, complete: true } });
    expect(resend.deliveredTo(ENV_ADMIN)).toBe(1);
  });

  it('a key already used for other bytes is parked as a conflict, never re-keyed, and reported for a person', async () => {
    resend.preuse(keyFor(TABLE_ADMIN), '{"other":"bytes"}');
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r).toMatchObject({ status: 502, body: { ok: false, needsAttention: 1, statuses: { accepted: everyone().length - 1, conflict: 1 } } });
    await tick('2026-09-30T13:31:00Z');
    expect(resend.requests.filter((q) => q.to === TABLE_ADMIN)).toHaveLength(1);
  });
});

describe('recipients', () => {
  it('an untrimmed, differently cased duplicate of an admin is one recipient', async () => {
    db.seed('super_admins', [{ email: ' Env-Admin@Example.test ' }]);
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r.body).toMatchObject({ ok: true, recipients: everyone().length });
    expect(resend.deliveredTo(ENV_ADMIN)).toBe(1);
  });

  it('an address the engine cannot use refuses the whole occurrence before anything is stored or sent (fail closed; docs §3)', async () => {
    db.seed('super_admins', [{ email: 'Ops <ops@example.test>' }]);
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r).toMatchObject({ status: 502, body: { ok: false, reason: 'plan_refused' } });
    expect(r.text).not.toMatch(/ops@/);
    expect(store.calls).toEqual([]);
    expect(resend.requests).toEqual([]);
  });

  it('an unreadable recipient list sends nothing (#685, unchanged)', async () => {
    const from = db.from.bind(db);
    state.db = { from: (t: string) => (t === 'super_admins' ? { select: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'injected' } }) }) }) } : from(t)) };
    const r = await tick('2026-09-30T12:31:00Z');
    expect(r).toMatchObject({ status: 502, body: { ok: false, reason: 'recipients_unavailable' } });
    expect(resend.requests).toEqual([]);
  });

  it('OPEN DECISION (docs §3): an admin removed after the freeze is still sent that slot\'s digest on a retry; only a count is reported', async () => {
    resend.script = ({ to, n }) => (to === TABLE_ADMIN && n === 1 ? 'reject_429' : 'accept');
    expect((await tick('2026-09-30T12:31:00Z')).status).toBe(502);
    const noTable = db.from.bind(db);
    state.db = { from: (t: string) => (t === 'super_admins' ? { select: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) } : noTable(t)) };
    const retry = await tick('2026-09-30T12:36:00Z');
    expect(retry.body).toMatchObject({ ok: true, planMismatch: { recipientsRemoved: 1, recipientsAdded: 0 } });
    expect(resend.deliveredTo(TABLE_ADMIN)).toBe(1);
  });

  it('activity that arrives inside a frozen slot\'s window changes nothing already frozen; the difference is reported', async () => {
    resend.script = ({ to, n }) => (to === TABLE_ADMIN && n === 1 ? 'reject_429' : 'accept');
    await tick('2026-09-30T12:31:00Z');
    happen('2026-09-30T11:00:00Z', 'Family C recorded late'); // inside the window, written after the freeze
    const retry = await tick('2026-09-30T12:36:00Z');
    expect(retry.body).toMatchObject({ ok: true, planMismatch: { payloadChanged: true } });
    const toTable = resend.inbox.filter((m) => m.to === TABLE_ADMIN);
    expect(toTable).toHaveLength(1);
    expect(toTable[0].body).not.toContain('Family C recorded late');
  });
});
