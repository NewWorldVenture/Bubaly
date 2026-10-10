import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MarketingCustomer } from '@/lib/marketing/customers';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A marketing automation run that does not fully succeed is recorded `failed`,
 * and both executors reclaim a `failed` run on their next pass and run ALL of
 * its steps again: the scheduled runner (/api/cron/automations, daily) and the
 * event path (`fireAutomationEvent`, which journey-recovery re-fires daily for
 * the same subject). Neither looked at what the earlier attempt had already
 * done, so a `send_email` that went out was sent again on every retry.
 *
 * And some runs can never succeed. Only `send_email` is executed today; every
 * other step the workflow builder offers (apply_tag, notify_admin, send_sms,
 * ...) is recorded `<action>:unsupported`, which marks the run failed. So a
 * workflow of "send_email, then apply_tag" mailed every customer it matched the
 * same email on every daily run, for as long as they matched.
 *
 * A retry must reach only what the earlier attempt did not: a failed, skipped
 * or never-attempted send is still retried, a delivered one is not repeated.
 */

const h = vi.hoisted(() => ({
  customers: [] as MarketingCustomer[],
  sends: [] as { to: string; subject: string }[],
  /** Provider answers, in order; once exhausted every send succeeds. */
  answers: [] as ('ok' | 'error')[],
}));

vi.mock('@/lib/email', () => ({
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
const DAY = 86_400_000;
const EMAIL = 'family@synthetic.invalid';

function inactiveCustomer(): MarketingCustomer {
  return {
    familyId: 'fam-1', name: 'Synthetic family', ownerEmail: EMAIL, memberCount: 3, plan: 'basic', planLabel: 'Basic',
    status: 'active', lifecycle: 'active', estLtvCents: 0,
    createdAt: new Date(Date.now() - 200 * DAY).toISOString(),
    lastActivityAt: new Date(Date.now() - 60 * DAY).toISOString(),
  } as MarketingCustomer;
}

function withWorkflow(trigger: string, steps: { action: string; subject?: string; body?: string }[]): InMemorySupabase {
  const db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  db.seed('marketing_automation_workflows', [{ id: 'wf-1', trigger, status: 'active', deleted_at: null, steps, run_count: 0 }]);
  return db;
}

const runs = (db: InMemorySupabase) => db.table('marketing_automation_runs');

beforeEach(() => {
  h.customers = [inactiveCustomer()];
  h.sends = [];
  h.answers = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the scheduled automation runner', () => {
  it('a workflow whose other step is not executable mails the customer once, not on every daily run', async () => {
    const db = withWorkflow('customer_inactive', [
      { action: 'send_email', subject: 'We miss you', body: 'Synthetic body' },
      { action: 'apply_tag' },
    ]);

    const days = [];
    for (let day = 0; day < 3; day++) days.push(await runAutomations(db as unknown as DB));

    expect(h.sends.map((s) => s.subject), 'emails sent across three daily runs').toEqual(['We miss you']);
    expect(days.map((d) => d.emails)).toEqual([1, 0, 0]);
    // The run is still honest about the step it could not do.
    expect(runs(db)).toHaveLength(1);
    expect(runs(db)[0].status).toBe('failed');
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'apply_tag:unsupported']);
  });

  it('a send the provider refused is still retried, and the run completes once it goes', async () => {
    const db = withWorkflow('customer_inactive', [{ action: 'send_email', subject: 'We miss you', body: 'Synthetic body' }]);
    h.answers = ['error'];

    const first = await runAutomations(db as unknown as DB);
    const second = await runAutomations(db as unknown as DB);
    const third = await runAutomations(db as unknown as DB);

    expect(h.sends.map((s) => s.subject)).toEqual(['We miss you', 'We miss you']);
    expect([first.emails, second.emails, third.emails]).toEqual([0, 1, 0]);
    expect(runs(db)[0].status).toBe('completed');
  });

  it('a retry sends only the email the earlier attempt did not deliver', async () => {
    const db = withWorkflow('customer_inactive', [
      { action: 'send_email', subject: 'First note', body: 'Synthetic body' },
      { action: 'send_email', subject: 'Second note', body: 'Synthetic body' },
    ]);
    h.answers = ['ok', 'error'];

    await runAutomations(db as unknown as DB);
    const retry = await runAutomations(db as unknown as DB);

    expect(h.sends.map((s) => s.subject)).toEqual(['First note', 'Second note', 'Second note']);
    expect(retry.emails).toBe(1);
    expect(runs(db)[0].status).toBe('completed');
    expect((runs(db)[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'send_email']);
  });
});

describe('the event-driven automation path', () => {
  const fire = (db: InMemorySupabase) => fireAutomationEvent(db as unknown as DB, {
    trigger: 'onboarding_abandoned', email: EMAIL, name: 'Synthetic', subjectKey: 'onboarding_abandoned:user-1',
  });

  it('a journey re-fired for the same subject does not mail them again', async () => {
    const db = withWorkflow('onboarding_abandoned', [
      { action: 'send_email', subject: 'Almost ready', body: 'Synthetic body' },
      { action: 'notify_admin' },
    ]);

    const results = [await fire(db), await fire(db), await fire(db)];

    expect(h.sends.map((s) => s.subject), 'emails sent across three sweeps').toEqual(['Almost ready']);
    expect(results.map((r) => r.emails)).toEqual([1, 0, 0]);
    expect(runs(db)).toHaveLength(1);
  });

  it('a send the provider refused is retried on the next sweep', async () => {
    const db = withWorkflow('onboarding_abandoned', [{ action: 'send_email', subject: 'Almost ready', body: 'Synthetic body' }]);
    h.answers = ['error'];

    await fire(db);
    const retry = await fire(db);
    await fire(db);

    expect(h.sends.map((s) => s.subject)).toEqual(['Almost ready', 'Almost ready']);
    expect(retry.emails).toBe(1);
    expect(runs(db)[0].status).toBe('completed');
  });
});
