// GET /api/cron/automations, driven at the request level: the real cron
// authorization (no cron-auth mock), the real route, the real scheduled runner,
// the real customer view and the real step runner over the in-memory database.
// Only the email provider is fake, at the seam the other automation tests stub
// (`@/lib/email`'s getResend).
//
// What the existing tests already prove and this file does not repeat:
//  - tests/an-automation-does-what-it-says-and-reaches-every-family.test.ts:
//    unrunnable workflows, the 200-per-pass cap, run_count per subject,
//    inactivity not read from the family row (runner + cron with a stubbed
//    secret, one family at a time).
//  - tests/an-opted-out-address-gets-no-automation-mail.test.ts: suppression and
//    List-Unsubscribe, with the customer view mocked.
//  - tests/stale-child-login-throttle-rows-are-pruned.test.ts and
//    tests/the-rate-limit-table-is-not-a-visitor-log.test.ts: the two prunes.
// Added here: the 401 paths touch nothing, a multi-household run over the REAL
// customer view (closed family, removed member, opted-out owner, already-served
// family, family that does not match), cross-family isolation of the mail,
// a second run that sends nothing, and the failure statuses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

type Sent = { to: string; subject: string; html: string; idempotencyKey: string | undefined };
const h = vi.hoisted(() => ({
  db: null as unknown,
  clients: 0,
  rpcCalls: 0,
  pruneFails: false,
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
      send: async (message: { to: string; subject: string; html: string }, options?: { idempotencyKey?: string }) => {
        if (h.refuseTo.has(message.to)) return { data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } };
        h.sent.push({ to: message.to, subject: message.subject, html: message.html, idempotencyKey: options?.idempotencyKey });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));

const { GET } = await import('@/app/api/cron/automations/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-10-12T10:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

const WF = '00000000-0000-4000-8000-0000000000f1';
const FAM_A = '00000000-0000-4000-8000-0000000000a1';
const FAM_B = '00000000-0000-4000-8000-0000000000b1';
const FAM_CLOSED = '00000000-0000-4000-8000-0000000000c1';
const FAM_OPTOUT = '00000000-0000-4000-8000-0000000000d1';
const FAM_DONE = '00000000-0000-4000-8000-0000000000e1';
const FAM_OLD = '00000000-0000-4000-8000-000000000011';

let db: InMemorySupabase;

function family(id: string, name: string, owner: string, opts: { subscribedDaysAgo: number; closedAt?: string; createdDaysAgo: number }) {
  db.seed('families', [{ id, name, created_at: iso(opts.createdDaysAgo), updated_at: iso(1), closed_at: opts.closedAt ?? null }]);
  db.seed('family_members', [{ id: `m-${id}`, family_id: id, user_id: `u-${id}-1`, role: 'parent', is_active: true }]);
  db.seed('profiles', [{ id: `u-${id}-1`, email: owner }]);
  db.seed('subscriptions', [{ id: `s-${id}`, family_id: id, plan: 'plus', status: 'active', created_at: iso(opts.subscribedDaysAgo), current_period_end: null }]);
}

function seedHouseholds() {
  db = createInMemorySupabase({
    rpc: { rate_limit_prune: () => { h.rpcCalls++; if (h.pruneFails) throw new Error('prune refused'); return null; } },
  });
  h.db = db;
  for (const table of ['marketing_suppressions', 'marketing_automation_runs', 'child_login_throttle']) db.seed(table, []);
  db.seed('marketing_automation_workflows', [{
    id: WF, name: 'Welcome', trigger: 'customer_created', status: 'active', deleted_at: null, run_count: 1,
    steps: [{ action: 'send_email', subject: 'Welcome to Bubaly' }],
  }]);
  // Two households the run must serve.
  family(FAM_A, 'Alder household', 'parent-a@example.com', { subscribedDaysAgo: 5, createdDaysAgo: 6 });
  family(FAM_B, 'Birch household', 'parent-b@example.com', { subscribedDaysAgo: 4, createdDaysAgo: 5 });
  // Birch also has a parent it removed; that member's user id sorts FIRST, so
  // only the is_active rule keeps the mail away from them.
  db.seed('family_members', [{ id: `m-${FAM_B}-gone`, family_id: FAM_B, user_id: `u-${FAM_B}-0`, role: 'parent', is_active: false }]);
  db.seed('profiles', [{ id: `u-${FAM_B}-0`, email: 'removed-b@example.com' }]);
  // Rows the run must skip.
  family(FAM_CLOSED, 'Cedar household', 'parent-closed@example.com', { subscribedDaysAgo: 3, createdDaysAgo: 4, closedAt: iso(1) });
  family(FAM_OPTOUT, 'Dogwood household', 'parent-optout@example.com', { subscribedDaysAgo: 3, createdDaysAgo: 3 });
  db.seed('marketing_suppressions', [{ email: 'parent-optout@example.com', reason: 'unsubscribe' }]);
  family(FAM_DONE, 'Elm household', 'parent-done@example.com', { subscribedDaysAgo: 2, createdDaysAgo: 2 });
  db.seed('marketing_automation_runs', [{
    id: 'run-done', workflow_id: WF, subject_key: FAM_DONE, status: 'completed',
    metadata: { trigger: 'customer_created', actions: ['send_email'] }, created_at: iso(1),
  }]);
  family(FAM_OLD, 'Fir household', 'parent-old@example.com', { subscribedDaysAgo: 200, createdDaysAgo: 210 });
}

const call = (authorization?: string) => GET(new NextRequest('https://bubaly.test/api/cron/automations',
  authorization === undefined ? {} : { headers: { authorization } }));
const runs = () => db.table('marketing_automation_runs');
const runFor = (familyId: string) => runs().find((r) => r.subject_key === familyId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('INTERNAL_SECRET', 'unsub-signing-key-not-real');
  h.clients = 0; h.rpcCalls = 0; h.pruneFails = false; h.sent = []; h.refuseTo = new Set();
  seedHouseholds();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer wrong-secret-not-real'],
    ['the secret without the Bearer scheme', SECRET],
  ])('API-8CC89F0675A6 JOB-71988A171BC7: %s answers 401 and touches nothing', async (_label, authorization) => {
    const res = await call(authorization);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'automations.unauthorized' });
    expect(h.clients, 'a database client was created').toBe(0);
    expect(db.log, 'a table was read or written').toEqual([]);
    expect(h.rpcCalls, 'the prune ran').toBe(0);
    expect(h.sent).toEqual([]);
    expect(runs().map((r) => r.id)).toEqual(['run-done']);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: an unset CRON_SECRET is never matched by "Bearer undefined"', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await call('Bearer undefined');
    expect(res.status).toBe(401);
    expect(h.clients).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: the right secret runs the job', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(h.clients).toBe(1);
    expect(h.rpcCalls).toBe(1);
  });
});

describe('a populated run', () => {
  it('API-8CC89F0675A6 JOB-71988A171BC7: mails each new household owner once and skips closed, removed, opted-out, served and non-matching ones', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workflows: 1, runs: 3, emails: 2, failures: 0, unserved: 0, unrunnable: 0,
      rateLimitsPruned: true, childLoginThrottlePruned: true, ok: true,
    });

    expect(h.sent.map((s) => s.to).sort()).toEqual(['parent-a@example.com', 'parent-b@example.com']);
    expect(h.sent.map((s) => s.subject)).toEqual(['Welcome to Bubaly', 'Welcome to Bubaly']);
    // Opted out: a run is recorded as honoured, no mail.
    expect(runFor(FAM_OPTOUT)).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ actions: ['send_email:suppressed'] }) });
    // Closed, not matching: no run at all. Already served: its row is untouched.
    expect(runFor(FAM_CLOSED)).toBeUndefined();
    expect(runFor(FAM_OLD)).toBeUndefined();
    expect(runs().filter((r) => r.subject_key === FAM_DONE)).toEqual([expect.objectContaining({ id: 'run-done', status: 'completed' })]);
    expect(runFor(FAM_A)).toMatchObject({ workflow_id: WF, status: 'completed', metadata: expect.objectContaining({ actions: ['send_email'] }) });
    expect(runFor(FAM_B)).toMatchObject({ workflow_id: WF, status: 'completed', metadata: expect.objectContaining({ actions: ['send_email'] }) });
    expect(runs()).toHaveLength(4);
    expect(db.table('marketing_automation_workflows')[0].run_count).toBe(4);
  });
});

describe('family isolation', () => {
  it('API-8CC89F0675A6 JOB-71988A171BC7: each mail carries only its own household and is keyed to its own run', async () => {
    await call(`Bearer ${SECRET}`);
    const toA = h.sent.find((s) => s.to === 'parent-a@example.com')!;
    const toB = h.sent.find((s) => s.to === 'parent-b@example.com')!;
    expect(toA.html).toContain('Alder household');
    expect(toB.html).toContain('Birch household');
    for (const other of ['Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir']) expect(toA.html, `A's mail names ${other}`).not.toContain(other);
    for (const other of ['Alder', 'Cedar', 'Dogwood', 'Elm', 'Fir']) expect(toB.html, `B's mail names ${other}`).not.toContain(other);
    // The provider idempotency key is the run of the family the mail went to.
    expect(toA.idempotencyKey).toBe(`marketing-automation/${runFor(FAM_A)!.id}/0`);
    expect(toB.idempotencyKey).toBe(`marketing-automation/${runFor(FAM_B)!.id}/0`);
    // Nobody outside the two households, and never the member Birch removed.
    expect(h.sent.map((s) => s.to)).not.toContain('removed-b@example.com');
    expect(h.sent.map((s) => s.to)).not.toContain('parent-closed@example.com');
    expect(h.sent.map((s) => s.to)).not.toContain('parent-optout@example.com');
    expect(h.sent.map((s) => s.to)).not.toContain('parent-done@example.com');
  });
});

describe('idempotence and failure', () => {
  it('API-8CC89F0675A6 JOB-71988A171BC7: a second run sends nothing and writes no new run', async () => {
    await call(`Bearer ${SECRET}`);
    const rowsAfterFirst = runs().map((r) => ({ ...r }));
    const second = await call(`Bearer ${SECRET}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ workflows: 1, runs: 0, emails: 0, failures: 0, unserved: 0, ok: true });
    expect(h.sent).toHaveLength(2);
    expect(runs()).toEqual(rowsAfterFirst);
    expect(db.table('marketing_automation_workflows')[0].run_count).toBe(4);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: a refused send is a 502, the other household is still mailed, and only the refused one is retried', async () => {
    h.refuseTo.add('parent-a@example.com');
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ runs: 3, emails: 1, failures: 1, ok: false });
    expect(h.sent.map((s) => s.to)).toEqual(['parent-b@example.com']);
    expect(runFor(FAM_A)).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ actions: ['send_email:failed'] }) });

    h.refuseTo.clear();
    const retry = await call(`Bearer ${SECRET}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ runs: 1, emails: 1, failures: 0, ok: true });
    expect(h.sent.map((s) => s.to)).toEqual(['parent-b@example.com', 'parent-a@example.com']);
    expect(runFor(FAM_A)!.status).toBe('completed');
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: an unreadable families table is a 500 and nobody is mailed or recorded', async () => {
    h.db = withFaults(db, (table) => (table === 'families' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'automations.automationRunFailed' });
    expect(h.sent).toEqual([]);
    expect(runs().map((r) => r.id)).toEqual(['run-done']);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: an unreadable workflow list is a 500, not a clean run of nothing', async () => {
    h.db = withFaults(db, (table) => (table === 'marketing_automation_workflows' ? { code: '57014', message: 'timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(h.sent).toEqual([]);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: a prune that did not land fails the run, and the households are still served', async () => {
    h.pruneFails = true;
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ rateLimitsPruned: false, childLoginThrottlePruned: true, failures: 0, emails: 2, ok: false });
    expect(h.sent.map((s) => s.to).sort()).toEqual(['parent-a@example.com', 'parent-b@example.com']);
  });

  it('API-8CC89F0675A6 JOB-71988A171BC7: a refused run-history read fails that workflow honestly and sends nothing for it', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'marketing_automation_runs' && calls.some((c) => c.method === 'select') && !calls.some((c) => c.method === 'insert' || c.method === 'update')
        ? { code: '57014', message: 'timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ workflows: 1, runs: 0, emails: 0, failures: 1, ok: false });
    expect(h.sent).toEqual([]);
    expect(runs().map((r) => r.id)).toEqual(['run-done']);
  });
});
