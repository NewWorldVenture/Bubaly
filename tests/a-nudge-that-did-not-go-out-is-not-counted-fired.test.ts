// A nudge that did not go out is not counted as fired.
//
// checkout-abandoned claimed the session (`status: 'abandoned'`) BEFORE the
// nudge and then did `await fireAutomationEvent(...); fired += 1;`, discarding
// the result. Inside, a failed workflows read returned `{ workflows: 0 }`, a
// refused reservation was `continue`d, and a send_email step that failed came
// back as `failures: 1` — and all three were counted `fired`, the route
// answered 200 ok:true, and the claimed row was never swept again: the nudge
// was lost for good. journey-recovery discarded the result the same way.
//
// fireAutomationEvent now reports `errors` beside `failures`; both routes read
// the result, count a nudge that did not go out as failed, and
// checkout-abandoned hands its claim back so the next run retries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sends: [] as string[],
  outcome: 'send_email' as 'send_email' | 'send_email:failed',
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/marketing/automation-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketing/automation-steps')>()),
  runSteps: async (_steps: unknown, recipient: { email: string | null }) => {
    h.sends.push(recipient.email ?? '');
    return [h.outcome];
  },
}));

const { GET: checkoutAbandoned } = await import('@/app/api/cron/checkout-abandoned/route');
const { GET: journeyRecovery } = await import('@/app/api/cron/journey-recovery/route');

let db: InMemorySupabase;
const NOW = new Date('2026-10-20T14:00:00.000Z');
const HOUR = 3_600_000;
const req = (path: string) => new Request(`https://bubaly.test${path}`) as never;
const session = () => db.table('checkout_sessions').find((s) => s.session_id === 'cs_1')!;
/** The workflows read refused; everything else answers. */
const refusingWorkflows = () => withFaults(db, (table) => (
  table === 'marketing_automation_workflows' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null
));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.sends = []; h.outcome = 'send_email';
  db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  h.db = db;
  db.seed('checkout_sessions', [{
    id: 'row-1', session_id: 'cs_1', family_id: null, email: 'parent@synthetic.invalid', name: 'Sam', status: 'pending',
    created_at: new Date(NOW.getTime() - 3 * HOUR).toISOString(), abandoned_at: null,
  }]);
  db.seed('marketing_automation_workflows', [
    { id: 'wf-ca', trigger: 'checkout_abandoned', status: 'active', deleted_at: null, steps: [{ action: 'send_email' }], run_count: 0 },
    { id: 'wf-ob', trigger: 'onboarding_abandoned', status: 'active', deleted_at: null, steps: [{ action: 'send_email' }], run_count: 0 },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('checkout-abandoned', () => {
  it('counts a nudge whose workflows read failed as failed, answers 502, and hands the claim back', async () => {
    h.db = refusingWorkflows();
    const res = await checkoutAbandoned(req('/api/cron/checkout-abandoned'));
    expect(res.status, 'a nudge nobody received was counted as fired').toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, fired: 0, failed: 1 });
    expect(h.sends).toEqual([]);
    // Pending again, so the next run retries inside the session's window.
    expect(session()).toMatchObject({ status: 'pending', abandoned_at: null });

    // The database answers: the next run nudges and keeps its claim.
    h.db = db;
    const next = await checkoutAbandoned(req('/api/cron/checkout-abandoned'));
    expect(await next.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
    expect(h.sends).toEqual(['parent@synthetic.invalid']);
    expect(session().status).toBe('abandoned');
  });

  it('counts a send that failed as failed, and the retry sends it', async () => {
    h.outcome = 'send_email:failed';
    const res = await checkoutAbandoned(req('/api/cron/checkout-abandoned'));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, fired: 0, failed: 1 });
    expect(session().status).toBe('pending');
    const run = db.table('marketing_automation_runs').find((r) => r.workflow_id === 'wf-ca')!;
    expect(run.status).toBe('failed');

    h.outcome = 'send_email';
    const next = await checkoutAbandoned(req('/api/cron/checkout-abandoned'));
    expect(await next.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
    expect(h.sends).toEqual(['parent@synthetic.invalid', 'parent@synthetic.invalid']);
    expect(run.status).toBe('completed');
    expect(session().status).toBe('abandoned');
  });

  it('control: a nudge that went out is fired, and the claim stands', async () => {
    const res = await checkoutAbandoned(req('/api/cron/checkout-abandoned'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
    expect(session().status).toBe('abandoned');
  });
});

describe('journey-recovery', () => {
  beforeEach(() => {
    db.seed('onboarding_progress', [{
      id: 'op-1', user_id: 'u-1', status: 'in_progress', completed_at: null, reset_at: null,
      created_at: new Date(NOW.getTime() - 5 * HOUR).toISOString(), updated_at: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
    }]);
    db.seed('profiles', [{ id: 'u-1', email: 'new@synthetic.invalid' }]);
  });

  it('counts a nudge whose workflows read failed as failed and answers 502', async () => {
    h.db = refusingWorkflows();
    const res = await journeyRecovery(req('/api/cron/journey-recovery'));
    expect(res.status, 'a nudge nobody received was counted as fired').toBe(502);
    expect(await res.json()).toMatchObject({ onboardingFired: 0, failed: 1 });
  });

  it('counts a send that failed as failed; the subject is re-swept next run', async () => {
    h.outcome = 'send_email:failed';
    expect(await (await journeyRecovery(req('/api/cron/journey-recovery'))).json()).toMatchObject({ onboardingFired: 0, failed: 1 });
    h.outcome = 'send_email';
    expect(await (await journeyRecovery(req('/api/cron/journey-recovery'))).json()).toMatchObject({ onboardingFired: 1, failed: 0 });
  });

  it('control: a nudge that went out is fired', async () => {
    const res = await journeyRecovery(req('/api/cron/journey-recovery'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ onboardingFired: 1, failed: 0 });
    expect(h.sends).toEqual(['new@synthetic.invalid']);
  });
});
