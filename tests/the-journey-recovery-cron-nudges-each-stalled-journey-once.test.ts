// GET /api/cron/journey-recovery, driven at the request level: the real cron
// authorization (no cron-auth mock), the real route, the real
// fireAutomationEvent and step runner over the in-memory database. Only the
// email provider is fake, at the seam the other automation tests stub
// (`@/lib/email`'s getResend).
//
// What the existing tests already prove and this file does not repeat:
//  - tests/journey-recovery-cron-boundary.test.ts: source-text guards that every
//    failure path adds to `failed` and the status follows it.
//  - tests/a-nudge-that-did-not-go-out-is-not-counted-fired.test.ts: a refused
//    workflows read and a failed step (runSteps mocked) answer 502, onboarding
//    sweep only.
// Added here: the 401 paths touch nothing, both sweeps populated over the real
// automation path (grace, max age, completed, reset, no profile, opted out,
// demo customer, non-demo lead), isolation of each nudge, a second run that
// sends and writes nothing, and a refused sweep read, profile read and send
// with the rest of the run proceeding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

type Sent = { to: string; subject: string; idempotencyKey: string | undefined };
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
      send: async (message: { to: string; subject: string }, options?: { idempotencyKey?: string }) => {
        if (h.refuseTo.has(message.to)) return { data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } };
        h.sent.push({ to: message.to, subject: message.subject, idempotencyKey: options?.idempotencyKey });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));

const { GET } = await import('@/app/api/cron/journey-recovery/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-10-20T14:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const U_A = '00000000-0000-4000-8000-0000000000a3';
const U_B = '00000000-0000-4000-8000-0000000000b3';
const U_FRESH = '00000000-0000-4000-8000-0000000000c3';
const U_COLD = '00000000-0000-4000-8000-0000000000d3';
const U_DONE = '00000000-0000-4000-8000-0000000000e3';
const U_RESET = '00000000-0000-4000-8000-0000000000f3';
const U_NOPROFILE = '00000000-0000-4000-8000-000000000013';
const U_OPTOUT = '00000000-0000-4000-8000-000000000023';

let db: InMemorySupabase;

function journey(id: string, userId: string, touchedAgoMs: number, extra: Record<string, unknown> = {}) {
  return {
    id, user_id: userId, status: 'in_progress', completed_at: null, reset_at: null,
    created_at: ago(touchedAgoMs + HOUR), updated_at: ago(touchedAgoMs), ...extra,
  };
}

function seed() {
  db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  h.db = db;
  db.seed('marketing_automation_runs', []);
  db.seed('marketing_suppressions', [{ email: 'optout@example.com', reason: 'unsubscribe' }]);
  db.seed('marketing_automation_workflows', [
    { id: 'wf-onboarding', name: 'Finish setup', trigger: 'onboarding_abandoned', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email', subject: 'Finish setting up' }] },
    { id: 'wf-demo', name: 'Demo follow-up', trigger: 'demo_abandoned', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email', subject: 'Your demo is waiting' }] },
  ]);
  db.seed('onboarding_progress', [
    // Two stalled journeys to nudge.
    journey('op-a', U_A, 5 * HOUR),
    journey('op-b', U_B, 6 * HOUR),
    // Skipped: still inside the grace window, past the look-back, finished, reset, no profile.
    journey('op-fresh', U_FRESH, 30 * MIN),
    journey('op-cold', U_COLD, 100 * HOUR),
    journey('op-done', U_DONE, 5 * HOUR, { status: 'completed', completed_at: ago(4 * HOUR) }),
    journey('op-reset', U_RESET, 5 * HOUR, { reset_at: ago(4 * HOUR) }),
    journey('op-noprofile', U_NOPROFILE, 5 * HOUR),
    // Opted out of marketing mail.
    journey('op-optout', U_OPTOUT, 5 * HOUR),
  ]);
  db.seed('profiles', [
    { id: U_A, email: 'a-parent@example.com' },
    { id: U_B, email: 'b-parent@example.com' },
    { id: U_FRESH, email: 'fresh@example.com' },
    { id: U_COLD, email: 'cold@example.com' },
    { id: U_DONE, email: 'done@example.com' },
    { id: U_RESET, email: 'reset@example.com' },
    { id: U_OPTOUT, email: 'optout@example.com' },
  ]);
  db.seed('crm_contacts', [
    { id: 'c-demo', email: 'demo-lead@example.com', lead_source: 'demo', lifecycle_stage: 'lead', created_at: ago(5 * HOUR) },
    // Skipped: became a customer, no address, not from the demo, too new.
    { id: 'c-customer', email: 'demo-customer@example.com', lead_source: 'demo', lifecycle_stage: 'customer', created_at: ago(5 * HOUR) },
    { id: 'c-noemail', email: null, lead_source: 'demo', lifecycle_stage: 'lead', created_at: ago(5 * HOUR) },
    { id: 'c-form', email: 'form-lead@example.com', lead_source: 'form', lifecycle_stage: 'lead', created_at: ago(5 * HOUR) },
    { id: 'c-fresh', email: 'fresh-lead@example.com', lead_source: 'demo', lifecycle_stage: 'lead', created_at: ago(10 * MIN) },
  ]);
}

const call = (authorization?: string) => GET(new NextRequest('https://bubaly.test/api/cron/journey-recovery',
  authorization === undefined ? {} : { headers: { authorization } }));
const runs = () => db.table('marketing_automation_runs');
const runFor = (subjectKey: string) => runs().find((r) => r.subject_key === subjectKey);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('INTERNAL_SECRET', 'unsub-signing-key-not-real');
  h.clients = 0; h.sent = []; h.refuseTo = new Set();
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer wrong-secret-not-real'],
  ])('API-A018B97030A5 JOB-9848A06C3416: %s answers 401 and touches nothing', async (_label, authorization) => {
    const res = await call(authorization);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'journeyRecovery.unauthorized' });
    expect(h.clients, 'a database client was created').toBe(0);
    expect(db.log, 'a table was read or written').toEqual([]);
    expect(h.sent).toEqual([]);
    expect(runs()).toEqual([]);
  });

  it('API-A018B97030A5 JOB-9848A06C3416: the right secret runs the job', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(h.clients).toBe(1);
  });
});

describe('a populated run', () => {
  it('API-A018B97030A5 JOB-9848A06C3416: nudges each stalled onboarding and demo lead once and skips the rest', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    // The opted-out journey is an honoured opt-out (a completed run), counted fired with no mail.
    expect(await res.json()).toEqual({ onboardingFired: 3, demoFired: 1, failed: 0 });
    expect(h.sent.map((s) => [s.to, s.subject]).sort()).toEqual([
      ['a-parent@example.com', 'Finish setting up'],
      ['b-parent@example.com', 'Finish setting up'],
      ['demo-lead@example.com', 'Your demo is waiting'],
    ]);
    expect(runs().map((r) => r.subject_key).sort()).toEqual([
      'demo_abandoned:demo-lead@example.com',
      `onboarding_abandoned:${U_OPTOUT}`,
      `onboarding_abandoned:${U_A}`,
      `onboarding_abandoned:${U_B}`,
    ]);
    expect(runFor(`onboarding_abandoned:${U_OPTOUT}`)).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ actions: ['send_email:suppressed'] }) });
    expect(runFor(`onboarding_abandoned:${U_A}`)).toMatchObject({ workflow_id: 'wf-onboarding', status: 'completed', metadata: expect.objectContaining({ userId: U_A, actions: ['send_email'] }) });
    expect(runFor('demo_abandoned:demo-lead@example.com')).toMatchObject({ workflow_id: 'wf-demo', status: 'completed' });
    expect(db.table('marketing_automation_workflows').map((w) => [w.id, w.run_count])).toEqual([['wf-onboarding', 3], ['wf-demo', 1]]);
    // The journeys themselves are read, never written.
    expect(db.table('onboarding_progress').map((r) => r.status)).toEqual(['in_progress', 'in_progress', 'in_progress', 'in_progress', 'completed', 'in_progress', 'in_progress', 'in_progress']);
  });
});

describe('isolation', () => {
  it('API-A018B97030A5 JOB-9848A06C3416: each nudge goes to its own user\'s address under its own run, and an onboarding nudge never reaches a demo lead', async () => {
    await call(`Bearer ${SECRET}`);
    const keyOf = (to: string) => h.sent.find((s) => s.to === to)!.idempotencyKey;
    expect(keyOf('a-parent@example.com')).toBe(`marketing-automation/${runFor(`onboarding_abandoned:${U_A}`)!.id}/0`);
    expect(keyOf('b-parent@example.com')).toBe(`marketing-automation/${runFor(`onboarding_abandoned:${U_B}`)!.id}/0`);
    expect(keyOf('demo-lead@example.com')).toBe(`marketing-automation/${runFor('demo_abandoned:demo-lead@example.com')!.id}/0`);
    expect(h.sent.filter((s) => s.to === 'demo-lead@example.com').map((s) => s.subject)).toEqual(['Your demo is waiting']);
    expect(h.sent).toHaveLength(3);
  });
});

describe('idempotence and failure', () => {
  it('API-A018B97030A5 JOB-9848A06C3416: a second run inside the window sends nothing and writes no new run', async () => {
    await call(`Bearer ${SECRET}`);
    const runsAfterFirst = runs().map((r) => ({ ...r }));
    const second = await call(`Bearer ${SECRET}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ failed: 0 });
    expect(h.sent).toHaveLength(3);
    expect(runs()).toEqual(runsAfterFirst);
    expect(db.table('marketing_automation_workflows').map((w) => w.run_count)).toEqual([3, 1]);
  });

  it('API-A018B97030A5 JOB-9848A06C3416: a refused onboarding read is a 502 and the demo sweep still runs', async () => {
    h.db = withFaults(db, (table) => (table === 'onboarding_progress' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ onboardingFired: 0, demoFired: 1, failed: 1 });
    expect(h.sent.map((s) => s.to)).toEqual(['demo-lead@example.com']);
  });

  it('API-A018B97030A5 JOB-9848A06C3416: a refused demo read is a 502 and the onboarding sweep still runs', async () => {
    h.db = withFaults(db, (table) => (table === 'crm_contacts' ? { code: '57014', message: 'timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ onboardingFired: 3, demoFired: 0, failed: 1 });
    expect(h.sent.map((s) => s.to).sort()).toEqual(['a-parent@example.com', 'b-parent@example.com']);
  });

  it('API-A018B97030A5 JOB-9848A06C3416: one refused profile read is counted, nudges nobody for that user, and the others proceed', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'profiles' && calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === U_A)
        ? { code: '57014', message: 'timeout' } : null));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ onboardingFired: 2, demoFired: 1, failed: 1 });
    expect(h.sent.map((s) => s.to).sort()).toEqual(['b-parent@example.com', 'demo-lead@example.com']);
    expect(runFor(`onboarding_abandoned:${U_A}`)).toBeUndefined();
  });

  it('API-A018B97030A5 JOB-9848A06C3416: a refused send is a 502, and the next run retries only it', async () => {
    h.refuseTo.add('b-parent@example.com');
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ onboardingFired: 2, demoFired: 1, failed: 1 });
    expect(runFor(`onboarding_abandoned:${U_B}`)!.status).toBe('failed');

    h.refuseTo.clear();
    const retry = await call(`Bearer ${SECRET}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ failed: 0 });
    expect(h.sent.map((s) => s.to).sort()).toEqual(['a-parent@example.com', 'b-parent@example.com', 'demo-lead@example.com']);
    expect(h.sent.at(-1)!.to).toBe('b-parent@example.com');
    expect(runFor(`onboarding_abandoned:${U_B}`)!.status).toBe('completed');
  });
});
