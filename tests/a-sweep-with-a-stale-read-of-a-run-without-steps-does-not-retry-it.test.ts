// RV1037-R2-AUTOMATION-STALE-LEGACY-CLAIM (AUD-1037-AUTOMATION-RETRY). A run
// that failed before attempts kept their steps has results and no snapshot.
// Two event sweeps for its subject, the workflow reordered between their
// reads: B claims it, carries First, fails Second again and records the same
// results beside the steps it ran. A's claim was fenced on the results alone,
// so it matched, and A retried from its stale read against the CURRENT steps:
// it took Second for sent and mailed First a second time. The claim now also
// requires the steps A read to be absent still (stepsRecorded), so A claims
// nothing and leaves the run to a pass that reads it afresh.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ sends: [] as { to: string; subject: string }[], answers: [] as ('ok' | 'error')[] }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://app.synthetic.invalid',
  FROM_EMAIL: 'Synthetic <synthetic@synthetic.invalid>',
  emailEnabled: () => true,
  getResend: () => ({ emails: { send: async (p: { to: string; subject: string }) => {
    h.sends.push({ to: p.to, subject: p.subject });
    const a = h.answers.shift() ?? 'ok';
    return a === 'ok' ? { data: { id: `e-${h.sends.length}` }, error: null } : { data: null, error: { name: 'application_error', message: 'x' } };
  } } }),
}));
vi.mock('@/lib/marketing/customers', () => ({ getMarketingCustomersWithError: async () => ({ customers: [], error: null }) }));
import { fireAutomationEvent } from '@/lib/marketing/automation-events';

type DB = SupabaseClient<Database>;
type Step = { action: string; subject?: string; body?: string };
const SUBJECT_KEY = 'onboarding_abandoned:user-1';
function deferred<T = void>() { let resolve!: (v: T | PromiseLike<T>) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

/** Hold the request after its first read of `table` completes. */
function heldAfterFirstRead(db: InMemorySupabase, table: string, release: Promise<void>) {
  const reached = deferred(); let held = false;
  const client = new Proxy(db, { get(target, key, receiver) {
    if (key !== 'from') return Reflect.get(target, key, receiver);
    return (name: string) => {
      const builder = target.from(name);
      if (name !== table) return builder;
      let first: string | null = null;
      const wrapped: object = new Proxy(builder, { get(object, method) {
        const value = Reflect.get(object, method, object);
        if (typeof value !== 'function') return value;
        const terminal = method === 'then' || method === 'maybeSingle' || method === 'single';
        if (!terminal) return (...args: unknown[]) => { if (first === null) first = String(method); const r = Reflect.apply(value, object, args); return r === object ? wrapped : r; };
        const settle = async (reply: unknown) => { if (first === 'select' && !held) { held = true; reached.resolve(); await release; } return reply; };
        if (method === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => (Reflect.apply(value, object, [(r: unknown) => r]) as Promise<unknown>).then(settle).then(res, rej);
        return (...args: unknown[]) => (Reflect.apply(value, object, args) as Promise<unknown>).then(settle);
      } });
      return wrapped;
    };
  } });
  return { client: client as unknown as DB, reached: reached.promise };
}

beforeEach(() => { h.sends = []; h.answers = []; vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('a sweep holding a stale read of a run without steps does not retry it once another sweep recorded them', () => {
  it('the event path: the delivered email is not sent again', async () => {
    const first: Step = { action: 'send_email', subject: 'First note', body: 'b' };
    const second: Step = { action: 'send_email', subject: 'Second note', body: 'b' };
    const db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
    db.seed('marketing_automation_workflows', [{ id: 'wf-1', trigger: 'onboarding_abandoned', status: 'active', deleted_at: null, steps: [first, second], run_count: 0 }]);
    // A run failed before attempts kept their steps: First delivered, Second failed.
    db.seed('marketing_automation_runs', [{ id: 'run-1', workflow_id: 'wf-1', subject_key: SUBJECT_KEY, status: 'failed',
      metadata: { trigger: 'onboarding_abandoned', actions: ['send_email', 'send_email:failed'] } }]);
    const fire = (c: DB) => fireAutomationEvent(c, { trigger: 'onboarding_abandoned', email: 'f@synthetic.invalid', name: 'S', subjectKey: SUBJECT_KEY });

    // Sweep B reads the workflow ([First, Second]) and is held.
    const releaseB = deferred();
    const b = heldAfterFirstRead(db, 'marketing_automation_workflows', releaseB.promise);
    const bRun = fire(b.client);
    await b.reached;
    // The workflow is reordered.
    db.table('marketing_automation_workflows')[0].steps = [{ ...second }, { ...first }];
    // Sweep A reads the edited workflow and the legacy run, and is held before its claim.
    const releaseA = deferred();
    const a = heldAfterFirstRead(db, 'marketing_automation_runs', releaseA.promise);
    // The run read is the existing-row select (the upsert is first, but its first method is upsert).
    const aRun = fire(a.client);
    await a.reached;
    // B claims, retries from [First, Second]: First carried, Second fails again -> same actions, now with a snapshot.
    h.answers = ['error'];
    releaseB.resolve();
    await bRun;
    expect((db.table('marketing_automation_runs')[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'send_email:failed']);
    expect((db.table('marketing_automation_runs')[0].metadata as { steps?: Step[] }).steps).toEqual([first, second]);
    // A's claim names a run with no steps; B recorded them, so it claims nothing.
    releaseA.resolve();
    await aRun;
    // Only B's attempt at Second went out; First, already delivered, did not again.
    expect(h.sends.map((s) => s.subject)).toEqual(['Second note']);
    expect(db.table('marketing_automation_runs')[0].status).toBe('failed');
  });
});
