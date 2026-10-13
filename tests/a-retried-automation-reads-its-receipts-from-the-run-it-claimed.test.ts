import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MarketingCustomer } from '@/lib/marketing/customers';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A failed marketing automation run is retried by both executors (the daily
 * scheduled runner and the event path), and a retry carries over every
 * `send_email` the earlier attempt recorded as delivered
 * (tests/a-retried-marketing-automation-does-not-resend-its-email.test.ts).
 * Owner coordinator finding AUD-1037-AUTOMATION-RETRY names two ways a retry
 * could still mail the same email twice.
 *
 * 1. Both executors read the run's receipts BEFORE claiming it
 *    (`failed` → `running`), and the claim returned only the id. Between that
 *    read and the claim, another pass could claim the run, deliver its email,
 *    fail on a later step and record the delivery; the first pass then claimed
 *    the run again and retried from the receipts it read before, which did
 *    not have that delivery. The claim is now fenced on the receipts that
 *    were read, so the run a retry claims is the run whose receipts it holds;
 *    one that changed in between is left, failed, for the next pass.
 *
 * 2. Receipts are matched to steps by position, and a retry ran the workflow's
 *    CURRENT steps. Reordered, or with a step put in front, after an attempt,
 *    the positions pointed at other steps: a delivered email was sent again
 *    and an undelivered one skipped. Every attempt now records the steps it
 *    ran beside their results, and a retry runs that snapshot. An edit reaches
 *    runs that start after it.
 */

const h = vi.hoisted(() => ({
  customers: [] as MarketingCustomer[],
  sends: [] as { to: string; subject: string }[],
  /** Provider answers, in order; once exhausted every send succeeds. */
  answers: [] as ('ok' | 'error')[],
}));

vi.mock('@/lib/email', () => ({
  APP_URL: 'https://app.synthetic.invalid',
  FROM_EMAIL: 'Synthetic <synthetic@synthetic.invalid>',
  emailEnabled: () => true,
  getResend: () => ({
    emails: {
      send: async (payload: { to: string; subject: string }) => {
        h.sends.push({ to: payload.to, subject: payload.subject });
        const answer = h.answers.shift() ?? 'ok';
        return answer === 'ok'
          ? { data: { id: `email-${h.sends.length}` }, error: null }
          : { data: null, error: { name: 'application_error', message: 'Synthetic provider failure' } };
      },
    },
  }),
}));
vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: h.customers, error: null }),
}));

import { runAutomations } from '@/lib/marketing/automation-runner';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';

type DB = SupabaseClient<Database>;
type Step = { action: string; subject?: string; body?: string };
const DAY = 86_400_000;
const EMAIL = 'family@synthetic.invalid';
const SUBJECT_KEY = 'onboarding_abandoned:user-1';

function inactiveCustomer(familyId = 'fam-1', ownerEmail = EMAIL): MarketingCustomer {
  return {
    familyId, name: 'Synthetic family', ownerEmail, memberCount: 3, plan: 'basic', planLabel: 'Basic',
    status: 'active', lifecycle: 'active', estLtvCents: 0,
    createdAt: new Date(Date.now() - 200 * DAY).toISOString(),
    lastActivityAt: new Date(Date.now() - 60 * DAY).toISOString(),
  } as MarketingCustomer;
}

function withWorkflow(trigger: string, steps: Step[]): InMemorySupabase {
  const db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  db.seed('marketing_automation_workflows', [{ id: 'wf-1', trigger, status: 'active', deleted_at: null, steps, run_count: 0 }]);
  return db;
}

/** The workflow edited in the builder: a NEW steps array, as a write to the row would leave it. */
function editWorkflow(db: InMemorySupabase, steps: Step[]) {
  db.table('marketing_automation_workflows')[0].steps = steps.map((step) => ({ ...step }));
}

const runs = (db: InMemorySupabase) => db.table('marketing_automation_runs');
const subjects = () => h.sends.map((s) => s.subject);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * The same database for one pass, held right after its first read of
 * `marketing_automation_runs` (the read that finds the failed run) until
 * `release` resolves. `reached` resolves when it gets there.
 */
function heldAfterRunRead(db: InMemorySupabase, release: Promise<void>) {
  const reached = deferred();
  let held = false;
  const client = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 'marketing_automation_runs') return builder;
        let first: string | null = null;
        const wrapped: object = new Proxy(builder, {
          get(object, method) {
            const value = Reflect.get(object, method, object);
            if (typeof value !== 'function') return value;
            const terminal = method === 'then' || method === 'maybeSingle' || method === 'single';
            if (!terminal) {
              return (...args: unknown[]) => {
                if (first === null) first = String(method);
                const result = Reflect.apply(value, object, args);
                return result === object ? wrapped : result;
              };
            }
            const settle = async (reply: unknown) => {
              if (first === 'select' && !held) { held = true; reached.resolve(); await release; }
              return reply;
            };
            if (method === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                (Reflect.apply(value, object, [(r: unknown) => r]) as Promise<unknown>).then(settle).then(resolve, reject);
            }
            return (...args: unknown[]) => (Reflect.apply(value, object, args) as Promise<unknown>).then(settle);
          },
        });
        return wrapped;
      };
    },
  });
  return { client: client as unknown as DB, reached: reached.promise };
}

beforeEach(() => {
  h.customers = [inactiveCustomer()];
  h.sends = [];
  h.answers = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a retry claims the run only as it read it', () => {
  // A run whose email has not gone yet: its send failed, and its other step cannot run.
  const pending = (trigger: string, other: string) => ({
    id: 'run-1', workflow_id: 'wf-1', subject_key: trigger === 'customer_inactive' ? 'fam-1' : SUBJECT_KEY, status: 'failed',
    metadata: { trigger, actions: ['send_email:failed', `${other}:unsupported`] },
  });

  it('the scheduled runner: a pass that read the run before another pass delivered its email does not send it again', async () => {
    const db = withWorkflow('customer_inactive', [
      { action: 'send_email', subject: 'We miss you', body: 'Synthetic body' },
      { action: 'apply_tag' },
    ]);
    db.seed('marketing_automation_runs', [pending('customer_inactive', 'apply_tag')]);
    const release = deferred();
    const late = heldAfterRunRead(db, release.promise);

    // Pass A reads the failed run, with no delivery on it, and is held there.
    const a = runAutomations(late.client);
    await late.reached;
    // Pass B claims the run, delivers the email, and records the run failed again (apply_tag cannot run).
    const b = await runAutomations(db as unknown as DB);
    expect(b.emails).toBe(1);
    expect(runs(db)[0]).toMatchObject({ status: 'failed' });
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'apply_tag:unsupported']);

    // A's claim is fenced on the receipts it read, which B has since changed: it claims nothing.
    release.resolve();
    expect(await a).toMatchObject({ runs: 0, emails: 0 });
    expect(subjects()).toEqual(['We miss you']);
    expect(runs(db)[0]).toMatchObject({ status: 'failed' });
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'apply_tag:unsupported']);
    // The next pass reads B's receipts and carries the email over.
    expect((await runAutomations(db as unknown as DB)).emails).toBe(0);
    expect(subjects()).toEqual(['We miss you']);
  });

  it('the event path: a sweep that read the run before another sweep delivered its email does not send it again', async () => {
    const db = withWorkflow('onboarding_abandoned', [
      { action: 'send_email', subject: 'Almost ready', body: 'Synthetic body' },
      { action: 'notify_admin' },
    ]);
    db.seed('marketing_automation_runs', [pending('onboarding_abandoned', 'notify_admin')]);
    const fire = (client: DB) => fireAutomationEvent(client, {
      trigger: 'onboarding_abandoned', email: EMAIL, name: 'Synthetic', subjectKey: SUBJECT_KEY,
    });
    const release = deferred();
    const late = heldAfterRunRead(db, release.promise);

    const a = fire(late.client);
    await late.reached;
    expect((await fire(db as unknown as DB)).emails).toBe(1);
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'notify_admin:unsupported']);

    release.resolve();
    expect(await a).toMatchObject({ workflows: 0, emails: 0 });
    expect(subjects()).toEqual(['Almost ready']);
    expect(runs(db)[0]).toMatchObject({ status: 'failed' });
    // The next sweep reads the delivery and does not repeat it.
    expect((await fire(db as unknown as DB)).emails).toBe(0);
    expect(subjects()).toEqual(['Almost ready']);
  });

  it('control: a failed run that recorded no results is still claimed, by both executors', async () => {
    const scheduled = withWorkflow('customer_inactive', [{ action: 'send_email', subject: 'We miss you', body: 'Synthetic body' }]);
    scheduled.seed('marketing_automation_runs', [{ id: 'run-1', workflow_id: 'wf-1', subject_key: 'fam-1', status: 'failed', metadata: { trigger: 'customer_inactive' } }]);
    expect((await runAutomations(scheduled as unknown as DB)).emails).toBe(1);
    expect(runs(scheduled)[0]).toMatchObject({ status: 'completed' });

    const events = withWorkflow('onboarding_abandoned', [{ action: 'send_email', subject: 'Almost ready', body: 'Synthetic body' }]);
    events.seed('marketing_automation_runs', [{ id: 'run-2', workflow_id: 'wf-1', subject_key: SUBJECT_KEY, status: 'failed', metadata: { trigger: 'onboarding_abandoned' } }]);
    const fired = await fireAutomationEvent(events as unknown as DB, {
      trigger: 'onboarding_abandoned', email: EMAIL, name: 'Synthetic', subjectKey: SUBJECT_KEY,
    });
    expect(fired.emails).toBe(1);
    expect(runs(events)[0]).toMatchObject({ status: 'completed' });
    expect(subjects()).toEqual(['We miss you', 'Almost ready']);
  });

  it('control: a pass that finds the run already claimed by another does nothing', async () => {
    const db = withWorkflow('customer_inactive', [{ action: 'send_email', subject: 'We miss you', body: 'Synthetic body' }]);
    db.seed('marketing_automation_runs', [pending('customer_inactive', 'apply_tag')]);
    const release = deferred();
    const late = heldAfterRunRead(db, release.promise);

    const a = runAutomations(late.client);
    await late.reached;
    // B delivers and completes the run: A's claim of a `failed` run then matches nothing.
    await runAutomations(db as unknown as DB);
    expect(runs(db)[0]).toMatchObject({ status: 'completed' });
    release.resolve();
    expect((await a).runs).toBe(0);
    expect(subjects()).toEqual(['We miss you']);
  });
});

describe('a retry matches each receipt to the step that produced it', () => {
  const first: Step = { action: 'send_email', subject: 'First note', body: 'Synthetic body' };
  const second: Step = { action: 'send_email', subject: 'Second note', body: 'Synthetic body' };
  const fire = (db: InMemorySupabase) => fireAutomationEvent(db as unknown as DB, {
    trigger: 'onboarding_abandoned', email: EMAIL, name: 'Synthetic', subjectKey: SUBJECT_KEY,
  });

  it('the scheduled runner: steps reordered after an attempt do not resend the delivered email or skip the failed one', async () => {
    const db = withWorkflow('customer_inactive', [first, second]);
    h.answers = ['ok', 'error'];
    await runAutomations(db as unknown as DB);
    expect(subjects()).toEqual(['First note', 'Second note']);

    editWorkflow(db, [second, first]);
    const retry = await runAutomations(db as unknown as DB);

    expect(subjects()).toEqual(['First note', 'Second note', 'Second note']);
    expect(retry.emails).toBe(1);
    expect(runs(db)[0].status).toBe('completed');
  });

  it('the event path: steps reordered after an attempt do not resend the delivered email or skip the failed one', async () => {
    const db = withWorkflow('onboarding_abandoned', [first, second]);
    h.answers = ['ok', 'error'];
    await fire(db);

    editWorkflow(db, [second, first]);
    const retry = await fire(db);

    expect(subjects()).toEqual(['First note', 'Second note', 'Second note']);
    expect(retry.emails).toBe(1);
    expect(runs(db)[0].status).toBe('completed');
  });

  it('a step put in front after an attempt does not shift the receipts onto other steps', async () => {
    const db = withWorkflow('customer_inactive', [first, second]);
    h.answers = ['ok', 'error'];
    await runAutomations(db as unknown as DB);

    editWorkflow(db, [{ action: 'send_email', subject: 'New opener', body: 'Synthetic body' }, first, second]);
    await runAutomations(db as unknown as DB);

    // The run finishes what it started: the failed email goes, the delivered one does not go again.
    expect(subjects()).toEqual(['First note', 'Second note', 'Second note']);
    expect(runs(db)[0].status).toBe('completed');
  });

  // A snapshot with an entry runSteps cannot read (AUD-1037-AUTOMATION-RETRY,
  // 03:23 successor) is still the snapshot: the retry runs it, not the current
  // steps against its receipts.
  it('the scheduled runner: a snapshot with an unreadable step is retried as recorded, not against the edited steps', async () => {
    const db = withWorkflow('customer_inactive', [first, null as unknown as Step]);
    await runAutomations(db as unknown as DB);
    expect(subjects()).toEqual(['First note']);
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'step:failed']);

    editWorkflow(db, [null as unknown as Step, first]);
    await runAutomations(db as unknown as DB);

    // First, delivered at index 0, is carried; the unreadable entry fails again.
    expect(subjects()).toEqual(['First note']);
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'step:failed']);
  });

  it('the event path: a snapshot with an unreadable step is retried as recorded, not against the edited steps', async () => {
    const db = withWorkflow('onboarding_abandoned', [first, null as unknown as Step]);
    await fire(db);
    expect(subjects()).toEqual(['First note']);

    editWorkflow(db, [null as unknown as Step, first]);
    await fire(db);

    expect(subjects()).toEqual(['First note']);
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'step:failed']);
  });

  it('control: a workflow edit reaches the runs that start after it', async () => {
    const db = withWorkflow('customer_inactive', [first, second]);
    h.answers = ['ok', 'error'];
    await runAutomations(db as unknown as DB);

    editWorkflow(db, [{ ...first, subject: 'First note, edited' }, second]);
    h.customers = [inactiveCustomer(), inactiveCustomer('fam-2', 'other@synthetic.invalid')];
    await runAutomations(db as unknown as DB);

    expect(h.sends).toEqual([
      { to: EMAIL, subject: 'First note' },
      { to: EMAIL, subject: 'Second note' },
      // The retry of fam-1's run carries its delivered first email over and sends the failed second.
      { to: EMAIL, subject: 'Second note' },
      // fam-2's run starts after the edit.
      { to: 'other@synthetic.invalid', subject: 'First note, edited' },
      { to: 'other@synthetic.invalid', subject: 'Second note' },
    ]);
  });

  it('control: a run recorded before attempts kept their steps is still matched against the current steps', async () => {
    const db = withWorkflow('customer_inactive', [first, second]);
    db.seed('marketing_automation_runs', [{
      id: 'run-1', workflow_id: 'wf-1', subject_key: 'fam-1', status: 'failed',
      metadata: { trigger: 'customer_inactive', actions: ['send_email', 'send_email:failed'] },
    }]);

    const retry = await runAutomations(db as unknown as DB);

    expect(subjects()).toEqual(['Second note']);
    expect(retry.emails).toBe(1);
    expect(runs(db)[0]).toMatchObject({ status: 'completed' });
    expect((runs(db)[0].metadata as { steps: Step[] }).steps).toEqual([first, second]);
  });
});
