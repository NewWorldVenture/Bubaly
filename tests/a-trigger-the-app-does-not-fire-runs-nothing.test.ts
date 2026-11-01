import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers round 8, the runtime fence. Whether a workflow can be switched
// on, and what its card says, is decided on FIRED_TRIGGERS; fireAutomationEvent
// ran any active workflow on whatever trigger it was handed. A static guard
// (a-trigger-the-app-fires-is-one-a-workflow-can-run-on) held its callers to
// the list, and rounds 4 to 7 each found a way past it (R7-2-AW-GUARD-TRIGGER-
// OVERRIDDEN: a spread after the literal it checked decided what fired). Now
// the function itself refuses a trigger outside the list before it reads
// anything. Driven through the real function and the real step runner over
// an in-memory database; only the mail provider is fake. Negative control:
// before the fence the spread-overridden call below ran the demo_started
// workflow and mailed its recipient.

const h = vi.hoisted(() => ({ sends: [] as { to: string; subject: string }[] }));

vi.mock('@/lib/email', () => ({
  APP_URL: 'https://app.synthetic.invalid',
  FROM_EMAIL: 'Synthetic <synthetic@synthetic.invalid>',
  emailEnabled: () => true,
  getResend: () => ({
    emails: {
      send: async (payload: { to: string; subject: string }) => {
        h.sends.push({ to: payload.to, subject: payload.subject });
        return { data: { id: `email-${h.sends.length}` }, error: null };
      },
    },
  }),
}));

import { fireAutomationEvent, type FireEventParams } from '@/lib/marketing/automation-events';
import { FIRED_TRIGGERS } from '@/lib/marketing/automation-triggers';

type DB = SupabaseClient<Database>;
const EMAIL = 'lead@synthetic.invalid';

let db: InMemorySupabase;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.sends = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  // An active workflow on each: one the app fires, and one it does not.
  db.seed('marketing_automation_workflows', [
    { id: 'wf-paid', name: 'Paid', trigger: 'payment_completed', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email', subject: 'Welcome aboard' }] },
    { id: 'wf-demo', name: 'Demo', trigger: 'demo_started', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email', subject: 'How was your demo?' }] },
  ]);
  db.log.length = 0;
});

const runs = () => db.table('marketing_automation_runs');
const runCount = (id: string) => db.table('marketing_automation_workflows').find((row) => row.id === id)?.run_count;

describe('fireAutomationEvent runs only on a trigger the app fires', () => {
  it('the list it checks leaves demo_started out, so the case below is one it must refuse', () => {
    expect(FIRED_TRIGGERS).toContain('payment_completed');
    expect(FIRED_TRIGGERS).not.toContain('demo_started');
  });

  it('control: a listed trigger proceeds, runs its workflow and mails once', async () => {
    const result = await fireAutomationEvent(db as unknown as DB, { trigger: 'payment_completed', email: EMAIL, subjectKey: 'payment_completed:s1' });
    expect(result).toEqual({ workflows: 1, emails: 1, failures: 0, errors: 0, unrunnable: 0 });
    expect(h.sends).toEqual([{ to: EMAIL, subject: 'Welcome aboard' }]);
    expect(runs().map((run) => [run.workflow_id, run.status])).toEqual([['wf-paid', 'completed']]);
    expect(runCount('wf-paid')).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('refuses an unlisted trigger passed by a spread that overrides the literal: no lookup, no run, no email, an error naming it', async () => {
    // R7-2-AW-GUARD-TRIGGER-OVERRIDDEN probe (1): type-clean, and the literal
    // the static guard read is not the trigger that arrives.
    const extra: Partial<FireEventParams> = { trigger: 'demo_started' };
    const result = await fireAutomationEvent(db as unknown as DB, { trigger: 'payment_completed', email: EMAIL, subjectKey: 'payment_completed:s1', ...extra });
    expect(result, 'an unlisted trigger was not refused').toEqual({ workflows: 0, emails: 0, failures: 0, errors: 1, unrunnable: 0 });
    expect(db.log, 'the workflows were read for an unlisted trigger').toEqual([]);
    expect(runs()).toEqual([]);
    expect(h.sends).toEqual([]);
    expect([runCount('wf-paid'), runCount('wf-demo')]).toEqual([0, 0]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('refused an event on a trigger the app does not fire'), { trigger: 'demo_started' });
  });

  it('reads the trigger once, so the one it checks is the one every read and write uses', async () => {
    // A getter that answers a listed trigger first and an unlisted one after:
    // a check that read it apart from the lookup would let demo_started run.
    let reads = 0;
    const params = {
      email: EMAIL,
      subjectKey: 'payment_completed:s2',
      get trigger() { reads += 1; return reads === 1 ? 'payment_completed' : 'demo_started'; },
    } as FireEventParams;
    const result = await fireAutomationEvent(db as unknown as DB, params);
    expect(reads, 'the trigger was read more than once').toBe(1);
    expect(result).toEqual({ workflows: 1, emails: 1, failures: 0, errors: 0, unrunnable: 0 });
    expect(runs().map((run) => [run.workflow_id, (run.metadata as { trigger: string }).trigger])).toEqual([['wf-paid', 'payment_completed']]);
    expect(h.sends.map((send) => send.subject)).toEqual(['Welcome aboard']);
  });
});
