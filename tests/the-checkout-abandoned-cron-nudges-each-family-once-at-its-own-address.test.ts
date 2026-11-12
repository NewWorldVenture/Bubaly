// GET /api/cron/checkout-abandoned, driven at the request level: the real cron
// authorization (no cron-auth mock), the real route, the real
// fireAutomationEvent and step runner over the in-memory database. Only the
// email provider is fake, at the seam the other automation tests stub
// (`@/lib/email`'s getResend).
//
// What the existing tests already prove and this file does not repeat:
//  - tests/an-abandoned-checkout-nudge-skips-a-family-that-paid.test.ts: the
//    webhook completing a session mid-run, an overlapping run's claim, an
//    earlier payment still nudged, the completed-checkouts read refused (with
//    the automation call mocked).
//  - tests/a-nudge-that-did-not-go-out-is-not-counted-fired.test.ts: a refused
//    workflows read and a failed step hand the claim back (runSteps mocked).
//  - tests/cron-checkout-abandoned-failure-status.test.ts: the 502 on failure.
// Added here: the 401 paths touch nothing, a multi-household run with the real
// automation path (grace, max age, no email, paid elsewhere, opted out,
// already abandoned), isolation of each nudge, a second run that sends nothing,
// a refused pending read, a refused claim and a refused send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

type Sent = { to: string; subject: string; html: string };
const h = vi.hoisted(() => ({
  db: null as unknown,
  clients: 0,
  sent: [] as Sent[],
  refuseTo: new Set<string>(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { h.clients++; return h.db; },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://bubaly.test',
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  getResend: () => ({
    emails: {
      send: async (message: { to: string; subject: string; html: string }) => {
        if (h.refuseTo.has(message.to)) return { data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } };
        h.sent.push({ to: message.to, subject: message.subject, html: message.html });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));

const { GET } = await import('@/app/api/cron/checkout-abandoned/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-10-20T14:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const WF = '00000000-0000-4000-8000-0000000000f2';
const FAM_A = '00000000-0000-4000-8000-0000000000a2';
const FAM_B = '00000000-0000-4000-8000-0000000000b2';
const FAM_PAID = '00000000-0000-4000-8000-0000000000c2';
const FAM_OPTOUT = '00000000-0000-4000-8000-0000000000d2';
const FAM_FRESH = '00000000-0000-4000-8000-0000000000e2';

let db: InMemorySupabase;

function session(sessionId: string, familyId: string | null, email: string | null, name: string, createdAgoMs: number, status = 'pending') {
  return {
    id: `row-${sessionId}`, session_id: sessionId, family_id: familyId, email, name, plan: 'plus', status,
    created_at: ago(createdAgoMs), completed_at: null, abandoned_at: null,
  };
}

function seedHouseholds() {
  db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  h.db = db;
  db.seed('marketing_automation_runs', []);
  db.seed('marketing_suppressions', [{ email: 'optout@example.com', reason: 'unsubscribe' }]);
  db.seed('marketing_automation_workflows', [{
    id: WF, name: 'Still thinking', trigger: 'checkout_abandoned', status: 'active', deleted_at: null, run_count: 0,
    steps: [{ action: 'send_email', subject: 'Still thinking it over?' }],
  }]);
  db.seed('checkout_sessions', [
    // Two households to nudge.
    session('cs_a', FAM_A, 'avery@example.com', 'Avery', 3 * HOUR),
    session('cs_b', FAM_B, 'blake@example.com', 'Blake', 2 * HOUR),
    // Inside the grace window: not yet abandoned.
    session('cs_fresh', FAM_FRESH, 'fresh@example.com', 'Fresh', 10 * MIN),
    // Past the look-back: never nudged.
    session('cs_stale', FAM_FRESH, 'stale@example.com', 'Stale', 30 * HOUR),
    // Nothing to send to.
    session('cs_noemail', null, null, 'Nobody', 3 * HOUR),
    // Paid through a later session: settled without a nudge.
    session('cs_paid_first', FAM_PAID, 'paid@example.com', 'Paige', 3 * HOUR),
    { ...session('cs_paid_second', FAM_PAID, 'paid@example.com', 'Paige', 2 * HOUR, 'completed'), completed_at: ago(2 * HOUR) },
    // Opted out of marketing mail.
    session('cs_optout', FAM_OPTOUT, 'optout@example.com', 'Olive', 3 * HOUR),
    // Already handled by an earlier run.
    { ...session('cs_done', FAM_A, 'avery@example.com', 'Avery', 5 * HOUR, 'abandoned'), abandoned_at: ago(4 * HOUR) },
  ]);
}

const call = (authorization?: string) => GET(new NextRequest('https://bubaly.test/api/cron/checkout-abandoned',
  authorization === undefined ? {} : { headers: { authorization } }));
const row = (sessionId: string) => db.table('checkout_sessions').find((r) => r.session_id === sessionId)!;
const runs = () => db.table('marketing_automation_runs');
const statuses = () => Object.fromEntries(db.table('checkout_sessions').map((r) => [r.session_id, r.status]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('INTERNAL_SECRET', 'unsub-signing-key-not-real');
  h.clients = 0; h.sent = []; h.refuseTo = new Set();
  seedHouseholds();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer wrong-secret-not-real'],
  ])('API-1D509B56AAEE JOB-E2101B7C487E: %s answers 401 and touches nothing', async (_label, authorization) => {
    const before = statuses();
    const res = await call(authorization);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'checkoutAbandoned.unauthorized' });
    expect(h.clients, 'a database client was created').toBe(0);
    expect(db.log, 'a table was read or written').toEqual([]);
    expect(h.sent).toEqual([]);
    expect(statuses()).toEqual(before);
  });

  it('API-1D509B56AAEE JOB-E2101B7C487E: the right secret runs the job', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(h.clients).toBe(1);
  });
});

describe('a populated run', () => {
  it('API-1D509B56AAEE JOB-E2101B7C487E: nudges each abandoned household once, settles the paid one, and leaves fresh, stale and address-less sessions alone', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    // pending read: a, b, fresh, stale, noemail, paid_first, optout.
    // abandoned now: a, b, paid_first, optout. The opted-out nudge is an
    // honoured opt-out (a completed run), so it counts as fired with no mail.
    expect(await res.json()).toEqual({ ok: true, pending: 7, abandoned: 4, fired: 3, superseded: 1, failed: 0 });

    expect(h.sent.map((s) => [s.to, s.subject]).sort()).toEqual([
      ['avery@example.com', 'Still thinking it over?'],
      ['blake@example.com', 'Still thinking it over?'],
    ]);
    expect(statuses()).toEqual({
      cs_a: 'abandoned', cs_b: 'abandoned', cs_fresh: 'pending', cs_stale: 'pending', cs_noemail: 'pending',
      cs_paid_first: 'abandoned', cs_paid_second: 'completed', cs_optout: 'abandoned', cs_done: 'abandoned',
    });
    expect(row('cs_a').abandoned_at).toBe(NOW.toISOString());
    expect(row('cs_done').abandoned_at, 'an already-handled row was re-stamped').toBe(ago(4 * HOUR));

    const bySubject = Object.fromEntries(runs().map((r) => [r.subject_key, r]));
    expect(Object.keys(bySubject).sort()).toEqual(['checkout_abandoned:cs_a', 'checkout_abandoned:cs_b', 'checkout_abandoned:cs_optout']);
    expect(bySubject['checkout_abandoned:cs_a']).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ sessionId: 'cs_a', actions: ['send_email'] }) });
    expect(bySubject['checkout_abandoned:cs_optout']).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ actions: ['send_email:suppressed'] }) });
    expect(db.table('marketing_automation_workflows')[0].run_count).toBe(3);
  });
});

describe('family isolation', () => {
  it('API-1D509B56AAEE JOB-E2101B7C487E: each nudge goes to its own session\'s address and names only that person', async () => {
    await call(`Bearer ${SECRET}`);
    const toA = h.sent.find((s) => s.to === 'avery@example.com')!;
    const toB = h.sent.find((s) => s.to === 'blake@example.com')!;
    expect(toA.html).toContain('Hi Avery');
    expect(toB.html).toContain('Hi Blake');
    for (const other of ['Blake', 'Paige', 'Olive', 'Fresh', 'Stale', 'Nobody']) expect(toA.html, `A's nudge names ${other}`).not.toContain(other);
    for (const other of ['Avery', 'Paige', 'Olive', 'Fresh', 'Stale', 'Nobody']) expect(toB.html, `B's nudge names ${other}`).not.toContain(other);
    // Each run row records its own session.
    for (const r of runs()) expect((r.metadata as { sessionId: string }).sessionId).toBe(String(r.subject_key).replace('checkout_abandoned:', ''));
    expect(h.sent.map((s) => s.to)).not.toContain('paid@example.com');
  });
});

describe('idempotence and failure', () => {
  it('API-1D509B56AAEE JOB-E2101B7C487E: a second run nudges nobody and writes nothing new', async () => {
    await call(`Bearer ${SECRET}`);
    const sessionsAfterFirst = db.table('checkout_sessions').map((r) => ({ ...r }));
    const runsAfterFirst = runs().map((r) => ({ ...r }));
    const second = await call(`Bearer ${SECRET}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, pending: 3, abandoned: 0, fired: 0, superseded: 0, failed: 0 });
    expect(h.sent).toHaveLength(2);
    expect(db.table('checkout_sessions')).toEqual(sessionsAfterFirst);
    expect(runs()).toEqual(runsAfterFirst);
  });

  it('API-1D509B56AAEE JOB-E2101B7C487E: a refused pending read is a 500 and nothing is claimed or sent', async () => {
    const before = statuses();
    h.db = withFaults(db, (table, calls) => (
      table === 'checkout_sessions' && calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'pending')
        && !calls.some((c) => c.method === 'update')
        ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'checkoutAbandoned.abandonedCheckoutProcessingFailed' });
    expect(h.sent).toEqual([]);
    expect(statuses()).toEqual(before);
    expect(runs()).toEqual([]);
  });

  it('API-1D509B56AAEE JOB-E2101B7C487E: a refused claim nudges nobody for that session, counts a failure, and the other households proceed', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'checkout_sessions' && calls.some((c) => c.method === 'update')
        && calls.some((c) => c.method === 'eq' && c.args[0] === 'session_id' && c.args[1] === 'cs_a')
        ? { code: '40001', message: 'could not serialize access' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, fired: 2, superseded: 1, failed: 1 });
    expect(h.sent.map((s) => s.to)).toEqual(['blake@example.com']);
    expect(row('cs_a')).toMatchObject({ status: 'pending', abandoned_at: null });
    expect(runs().map((r) => r.subject_key)).not.toContain('checkout_abandoned:cs_a');

    // The next run takes it.
    h.db = db;
    const next = await call(`Bearer ${SECRET}`);
    expect(await next.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
    expect(h.sent.map((s) => s.to)).toEqual(['blake@example.com', 'avery@example.com']);
  });

  it('API-1D509B56AAEE JOB-E2101B7C487E: a refused send is a 502, its session is handed back, and only it is retried', async () => {
    h.refuseTo.add('blake@example.com');
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, fired: 2, failed: 1 });
    expect(h.sent.map((s) => s.to)).toEqual(['avery@example.com']);
    expect(row('cs_b')).toMatchObject({ status: 'pending', abandoned_at: null });
    expect(row('cs_a').status).toBe('abandoned');

    h.refuseTo.clear();
    const retry = await call(`Bearer ${SECRET}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, abandoned: 1, fired: 1, failed: 0 });
    expect(h.sent.map((s) => s.to)).toEqual(['avery@example.com', 'blake@example.com']);
    expect(row('cs_b').status).toBe('abandoned');
  });
});
