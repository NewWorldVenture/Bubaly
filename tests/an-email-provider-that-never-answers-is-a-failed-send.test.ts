// An email provider that never answers is a failed send, not a held worker.
//
// The Resend SDK calls fetch with no signal, so a connection the provider
// accepts and never answers waited for undici's 300 s header timeout. The
// weekly digest and the chore reminders send eight at once and check their
// budget only between batches: one hung send held its batch past the budget
// into the platform's kill, with no response and every family after it
// unserved. The marketing automation step called the provider the same way,
// and a step that timed out after the provider accepted it is retried as a
// failed step, so its retry has to fold into the first send, not mail again.
//
// Driven through the real sendReactEmail, the real automation step and the
// real scheduled runner against the in-memory database; only the SDK's
// network call is replaced, by one that can hang.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MarketingCustomer } from '@/lib/marketing/customers';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const provider = vi.hoisted(() => ({
  calls: [] as { payload: Record<string, unknown>; options: { idempotencyKey?: string } | undefined }[],
  /** Answers in order; once exhausted every send is accepted. */
  answers: [] as ('hang' | 'ok')[],
  customers: [] as unknown[],
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: (payload: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
        provider.calls.push({ payload, options });
        return (provider.answers.shift() ?? 'ok') === 'hang'
          ? new Promise(() => {})
          : Promise.resolve({ data: { id: `email-${provider.calls.length}` }, error: null });
      },
    };
  },
}));
vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: provider.customers, error: null }),
}));

type DB = SupabaseClient<Database>;
const DEADLINE_MS = 15_000;

/** Whether `promise` has settled after the clock is moved `ms` on. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
  let settled = false;
  let value: T | undefined;
  void promise.then((v) => { settled = true; value = v; });
  await vi.advanceTimersByTimeAsync(ms);
  return { settled, value };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('RESEND_API_KEY', 're_synthetic_not_real');
  vi.stubEnv('INTERNAL_SECRET', 'provider-deadline-fixture');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  provider.calls = [];
  provider.answers = [];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('sendReactEmail', () => {
  it('answers { ok: false } once the provider has not answered within the deadline', async () => {
    const { sendReactEmail } = await import('@/lib/email');
    provider.answers = ['hang'];
    const sent = await settlesWithin(sendReactEmail({ to: 'parent@example.test', subject: 'Your week', react: createElement('p', null, 'Hi') }), DEADLINE_MS);
    expect(sent.settled, 'a provider that never answered held the send for as long as the connection lived').toBe(true);
    expect(sent.value).toEqual({ ok: false });
  });

  it('a keyed send keeps its key and its arguments exactly (control)', async () => {
    const { sendReactEmail } = await import('@/lib/email');
    expect(await sendReactEmail({ to: 'parent@example.test', subject: 'Your week', react: createElement('p', null, 'Hi'), idempotencyKey: 'weekly-digest/abc' })).toEqual({ ok: true });
    expect(provider.calls[0].options).toEqual({ idempotencyKey: 'weekly-digest/abc' });
  });
});

describe('the marketing automation send_email step', () => {
  it('records a provider that never answered as a failed step, and the run moves on', async () => {
    const { runSteps } = await import('@/lib/marketing/automation-steps');
    provider.answers = ['hang'];
    const db = createInMemorySupabase();
    const steps = settlesWithin(runSteps([{ action: 'send_email', subject: 'Hello', body: 'A note.' }, { action: 'send_email', subject: 'Again', body: 'A note.' }],
      { email: 'reader@example.test', name: 'Ana' }, { subject: 'Hello', body: 'A note.' }, db as unknown as DB), DEADLINE_MS);
    const result = await steps;
    expect(result.settled).toBe(true);
    expect(result.value).toEqual(['send_email:failed', 'send_email']);
  });

  it('the scheduled runner retries a timed-out send under the same key, so the provider folds it', async () => {
    const DAY = 86_400_000;
    provider.customers = [{
      familyId: 'fam-1', name: 'Synthetic family', ownerEmail: 'family@example.test', memberCount: 3, plan: 'basic', planLabel: 'Basic',
      status: 'active', lifecycle: 'active', estLtvCents: 0,
      createdAt: new Date(Date.now() - 200 * DAY).toISOString(), lastActivityAt: new Date(Date.now() - 60 * DAY).toISOString(),
    } as MarketingCustomer];
    const db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
    db.seed('marketing_automation_workflows', [{ id: 'wf-1', trigger: 'customer_inactive', status: 'active', deleted_at: null, steps: [{ action: 'send_email', subject: 'We miss you', body: 'Synthetic body' }], run_count: 0 }]);
    const { runAutomations } = await import('@/lib/marketing/automation-runner');

    provider.answers = ['hang'];
    const first = await settlesWithin(runAutomations(db as unknown as DB), DEADLINE_MS);
    expect(first.settled, 'the runner waited on the hung send').toBe(true);
    const run = db.table('marketing_automation_runs')[0];
    expect(run.status).toBe('failed');

    await runAutomations(db as unknown as DB);
    expect(db.table('marketing_automation_runs')[0].status).toBe('completed');
    const keys = provider.calls.map((call) => call.options?.idempotencyKey);
    expect(keys, 'the retry was a new send the provider could not fold into the first').toEqual([`marketing-automation/${run.id}/0`, `marketing-automation/${run.id}/0`]);
    // The same bytes under the same key: what lets the provider fold them.
    expect(provider.calls[1].payload).toEqual(provider.calls[0].payload);
  });
});
