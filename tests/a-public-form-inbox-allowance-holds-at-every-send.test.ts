// AUD-1028-M3 — "one automation mail per inbox per day" bounded EVENTS, not
// mail.
//
// firePublicFormSubmitted claimed the inbox's daily allowance and then fired
// form_submitted. But one event fans out: fireAutomationEvent runs every active
// form_submitted workflow, and runSteps sends every send_email step in each. An
// admin with two such workflows of two steps each had a public form mail a
// stranger's inbox four times per allowance.
//
// Now the allowance is enforced where mail is admitted: the event carries a
// one-mail admission that runSteps asks immediately before each send, and every
// send after the first is recorded as `send_email:throttled` (a bound that held,
// not a failure). Automations for verified addresses — account, billing,
// campaign engagement — pass no admission and send every step, as before.
//
// Driven through the real contact and form routes, the real dispatcher and the
// real step runner over an in-memory database. Only the provider is fake.
// Negative control: before the fix each public submission below sends four.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as Record<string, unknown>[] }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock('@/lib/email', () => ({
  getResend: () => ({
    emails: {
      send: async (message: Record<string, unknown>) => {
        h.sent.push(message);
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));

const FORM_ID = 'form-newsletter';

function limiter(args: Record<string, unknown>, store: InMemorySupabase) {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = store.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}

let db: InMemorySupabase;

/** Two active workflows on `trigger`, each with two send_email steps. */
function seed(trigger: string) {
  db = createInMemorySupabase({
    uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] },
    rpc: { rate_limit_hit: limiter },
  });
  db.seed('marketing_automation_workflows', [
    { id: 'wf-ack', trigger, status: 'active', deleted_at: null, run_count: 0,
      steps: [{ action: 'send_email', subject: 'Thanks' }, { action: 'send_email', subject: 'A tour' }] },
    { id: 'wf-nurture', trigger, status: 'active', deleted_at: null, run_count: 0,
      steps: [{ action: 'send_email', subject: 'Hello again' }, { action: 'send_email', subject: 'One more thing' }] },
  ]);
  db.seed('marketing_forms', [{
    id: FORM_ID, name: 'Newsletter', status: 'active', deleted_at: null,
    fields: [
      { label: 'Full name', key: 'full_name', type: 'text', required: true },
      { label: 'Email', key: 'email', type: 'email', required: true },
    ],
  }]);
  h.db = db;
}

async function contact(email: string, ip: string, name = 'Jordan') {
  const { POST } = await import('@/app/api/contact/route');
  return POST(new Request('https://bubaly.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ name, email, topic: 'general', message: 'Hello there, I have a question.' }),
  }));
}

async function formSubmit(email: string, ip: string) {
  const { POST } = await import('@/app/api/forms/submit/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ formId: FORM_ID, values: { full_name: 'Jordan', email } }),
  }));
}

const actionsOf = (workflowId: string) =>
  db.table('marketing_automation_runs')
    .filter((r) => r.workflow_id === workflowId)
    .map((r) => [r.status, (r.metadata as { actions: string[] }).actions]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules();
  h.sent = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a public submission sends one mail, however many workflows and steps match', () => {
  it('contact: two workflows of two send steps mail the inbox once', async () => {
    seed('form_submitted');
    const res = await contact('target@example.com', '198.51.100.1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(h.sent.map((m) => [m.to, m.subject])).toEqual([['target@example.com', 'Thanks']]);
    // Both workflows ran; the bound holding is a completed run, not a failure.
    expect(actionsOf('wf-ack')).toEqual([['completed', ['send_email', 'send_email:throttled']]]);
    expect(actionsOf('wf-nurture')).toEqual([['completed', ['send_email:throttled', 'send_email:throttled']]]);
  });

  it('forms: the same bound holds for a public form submission', async () => {
    seed('form_submitted');
    const res = await formSubmit('reader@example.com', '198.51.100.2');
    expect(res.status).toBe(200);
    expect(h.sent.map((m) => m.to)).toEqual(['reader@example.com']);
  });

  it('the day after, the inbox gets its next single acknowledgement', async () => {
    seed('form_submitted');
    await contact('target@example.com', '198.51.100.3');
    await formSubmit('target+again@example.com', '198.51.100.4'); // same inbox, same day
    expect(h.sent).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-13T10:05:00Z'));
    await contact('target@example.com', '198.51.100.5');
    expect(h.sent.map((m) => m.to)).toEqual(['target@example.com', 'target@example.com']);
  });

  it('a different inbox has its own single acknowledgement', async () => {
    seed('form_submitted');
    await contact('first@example.com', '198.51.100.6');
    await contact('second@example.com', '198.51.100.7');
    expect(h.sent.map((m) => m.to)).toEqual(['first@example.com', 'second@example.com']);
  });
});

describe('automations for verified addresses keep every step (positive controls)', () => {
  it('a billing event sends both steps of both workflows', async () => {
    seed('payment_completed');
    const { fireAutomationEvent } = await import('@/lib/marketing/automation-events');
    const result = await fireAutomationEvent(db as never, {
      trigger: 'payment_completed',
      email: 'customer@example.com',
      name: 'Rivera',
      subjectKey: 'payment_completed:cs_fixture',
    });
    expect(result).toEqual({ workflows: 2, emails: 4, failures: 0 });
    expect(h.sent.map((m) => m.subject)).toEqual(['Thanks', 'A tour', 'Hello again', 'One more thing']);
  });
});

describe('the greeting bound is a bound, as stated (pins the documented qualification)', () => {
  it('three plain words still reach the greeting; a fourth, a digit or a URL does not', async () => {
    const { greetingName } = await import('@/lib/marketing/public-form-automation');
    expect(greetingName('Verify Your Account')).toBe('Verify Your Account');
    expect(greetingName('Verify Your Account Now')).toBeNull();
    expect(greetingName('Account 2')).toBeNull();
    expect(greetingName('bubaly-verify.example')).toBeNull();

    seed('form_submitted');
    await contact('bounded@example.com', '198.51.100.8', 'Verify Your Account');
    expect(String(h.sent[0].html)).toContain('<p>Hi Verify Your Account,</p>');
  });
});
