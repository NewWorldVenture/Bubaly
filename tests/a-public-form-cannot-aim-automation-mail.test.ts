// P1 / P5 / P6 — the public contact and marketing-form endpoints made Bubaly's
// own sender mail any address a stranger typed, as often as they had IPs, with
// a greeting the stranger wrote.
//
// Both routes fire the form_submitted automation. Nobody is signed in there, so
// the recipient is an address the caller only CLAIMS, and the subject key is a
// fresh ticket or submission id each time, so nothing ever deduped. The only
// bound was per IP. And runSteps opened every mail with "Hi <name>," from the
// caller's own field — escaped as HTML, but a sentence and a bare URL read just
// as well escaped.
//
// These drive the REAL routes, the real automation dispatcher and the real
// step runner, against an in-memory database with an active form_submitted
// workflow (what an admin turns on in /admin/marketing/automation). Only the
// provider is replaced, so "a mail was sent" is a call that reached Resend.
//
// Each case is a negative control: on the tree before the fix the per-inbox
// cases send one mail per submission, the greeting carries the caller's
// sentence, and an opted-out or suppressed address is mailed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The support-inbox notice the contact route also sends; not what is under test.
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

const FORM_ID = '7e3c2d1a-5b4f-4c8e-9a1d-2f3e4b5c6d7e';

/** rate_limit_hit (0156/0179) over a table, fixed windows, every hit counted. */
function limiter(args: Record<string, unknown>, db: InMemorySupabase) {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = db.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}

let db: InMemorySupabase;

function seed(extra: { suppressions?: Row[] } = {}) {
  db = createInMemorySupabase({
    uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] },
    rpc: { rate_limit_hit: limiter },
  });
  db.seed('marketing_automation_workflows', [{
    id: 'wf-ack', trigger: 'form_submitted', status: 'active', deleted_at: null, run_count: 0,
    steps: [{ action: 'send_email' }],
  }]);
  db.seed('marketing_forms', [{
    id: FORM_ID, name: 'Newsletter', status: 'active', deleted_at: null,
    fields: [
      { label: 'Full name', key: 'full_name', type: 'text', required: true },
      { label: 'Email', key: 'email', type: 'email', required: true },
    ],
  }]);
  if (extra.suppressions) db.seed('marketing_suppressions', extra.suppressions);
  h.db = db;
}

async function contact(body: Record<string, unknown>, ip: string) {
  const { POST } = await import('@/app/api/contact/route');
  return POST(new Request('https://bubaly.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ topic: 'general', message: 'Hello there, I have a question.', ...body }),
  }));
}

async function formSubmit(values: Record<string, unknown>, ip: string) {
  const { POST } = await import('@/app/api/forms/submit/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/forms/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ formId: FORM_ID, values }),
  }));
}

const mailTo = (inbox: RegExp) => h.sent.filter((m) => inbox.test(String(m.to)));

beforeEach(() => {
  // One fixed instant, so no case straddles a limiter window boundary.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules(); // a fresh per-instance limiter for every case
  h.sent = [];
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one inbox gets one automation mail a day, however it is spelled or sent', () => {
  it('contact: rotating IPs and +tags no longer multiply the mail to one inbox', async () => {
    const spellings = ['victim@gmail.com', 'victim+1@gmail.com', 'v.ictim+2@gmail.com', 'VICTIM@googlemail.com', 'vic.tim+zz@gmail.com'];
    for (const [i, email] of spellings.entries()) {
      const res = await contact({ name: 'Jordan', email }, `198.51.100.${i + 1}`);
      // The answer does not move with the throttle: it would say how often an
      // address had been submitted by somebody else.
      expect(res.status, email).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(mailTo(/@g(oogle)?mail\.com$/)).toHaveLength(1);
    // The support ticket is still filed for every one of them.
    expect(db.table('support_tickets')).toHaveLength(spellings.length);
  });

  it('forms: the same bound holds for a public form, across both routes', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await formSubmit({ full_name: 'Jordan', email: `target+${i}@example.com` }, `203.0.113.${i + 1}`);
      expect(res.status).toBe(200);
    }
    expect(mailTo(/^target/)).toHaveLength(1);
    // The submissions themselves are all recorded; only the mail is bounded.
    expect(db.table('marketing_form_submissions')).toHaveLength(5);

    // And the contact form cannot be used to reach the same inbox again today.
    await contact({ name: 'Jordan', email: 'target@example.com' }, '192.0.2.200');
    expect(mailTo(/^target/)).toHaveLength(1);
  });

  it('still sends the acknowledgement to a first-time address (positive control)', async () => {
    await contact({ name: 'Ana-María O’Neil', email: 'ana@example.com' }, '192.0.2.10');
    expect(mailTo(/^ana@/)).toHaveLength(1);
    expect(String(h.sent[0].html)).toContain('Hi Ana-María O’Neil,');
  });
});

// A bound, not an elimination: a short name-shaped run of letters still
// reaches the greeting (tests/a-public-form-inbox-allowance-holds-at-every-send.test.ts
// pins exactly how much).
describe('the greeting carries no sentence or URL of the caller’s', () => {
  const LURE = 'there - your Bubaly account will be closed today. Keep it at bubaly-verify.example/login';

  it('contact: a sentence and a URL in the name field never reach the mail', async () => {
    const res = await contact({ name: LURE, email: 'mark@example.com' }, '192.0.2.20');
    expect(res.status).toBe(200);
    const [mail] = mailTo(/^mark@/);
    expect(mail, 'the acknowledgement is still sent').toBeTruthy();
    expect(String(mail.html)).toContain('<p>Hi there,</p>');
    expect(String(mail.html)).not.toContain('bubaly-verify.example');
    expect(String(mail.html)).not.toContain('closed today');
  });

  it('contact: a short sentence with no punctuation is not taken for a name', async () => {
    const res = await contact({ name: 'there your Bubaly account will be closed', email: 'quiet@example.com' }, '192.0.2.21');
    expect(res.status).toBe(200);
    const [mail] = mailTo(/^quiet@/);
    expect(mail).toBeTruthy();
    expect(String(mail.html)).toContain('<p>Hi there,</p>');
    expect(String(mail.html)).not.toContain('account will be closed');
  });

  it('forms: a 30 KB name field is not mailed', async () => {
    const essay = `Jordan ${'click https://evil.example/x '.repeat(1_000)}`;
    const res = await formSubmit({ full_name: essay, email: 'long@example.com' }, '192.0.2.30');
    expect(res.status).toBe(200);
    const [mail] = mailTo(/^long@/);
    expect(mail).toBeTruthy();
    expect(String(mail.html)).toContain('<p>Hi there,</p>');
    expect(String(mail.html)).not.toContain('evil.example');
    expect(String(mail.html).length).toBeLessThan(2_000);
  });
});

describe('an address that opted out is not mailed through a public form', () => {
  it('contact: a suppressed address gets nothing, and the run is not a failure', async () => {
    seed({ suppressions: [{ email: 'optout@example.com', reason: 'unsubscribe' }] });
    const res = await contact({ name: 'Jordan', email: 'OptOut@Example.com' }, '192.0.2.40');
    expect(res.status).toBe(200);
    expect(h.sent).toEqual([]);
    const [run] = db.table('marketing_automation_runs');
    expect(run.status).toBe('completed');
    expect((run.metadata as { actions: string[] }).actions).toEqual(['send_email:suppressed']);
  });

  it('contact: a +tag or Gmail-dot spelling does not reach an inbox that opted out', async () => {
    seed({ suppressions: [{ email: 'victim@gmail.com', reason: 'unsubscribe' }] });
    for (const [i, email] of ['victim+day1@gmail.com', 'v.ictim@gmail.com', 'Victim+x@googlemail.com'].entries()) {
      // A fresh limiter per spelling, so only the opt-out can stop the mail.
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 12 + i, 10, 5)));
      const res = await contact({ name: 'Jordan', email }, `192.0.2.${50 + i}`);
      expect(res.status, email).toBe(200);
    }
    expect(h.sent).toEqual([]);
  });

  it('forms: a suppressed address gets nothing', async () => {
    seed({ suppressions: [{ email: 'bounced@example.com', reason: 'bounce' }] });
    await formSubmit({ full_name: 'Jordan', email: 'bounced@example.com' }, '192.0.2.41');
    expect(h.sent).toEqual([]);
  });

  it('every mail it does send carries the signed one-click way out', async () => {
    const { verifyUnsubToken } = await import('@/lib/marketing/unsubscribe');
    await formSubmit({ full_name: 'Jordan', email: 'reader@example.com' }, '192.0.2.42');
    const [mail] = mailTo(/^reader@/);
    const headers = mail.headers as Record<string, string>;
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = new URL(/^<(.+)>$/.exec(headers['List-Unsubscribe'])![1]);
    expect(`${url.origin}${url.pathname}`).toBe('https://bubaly.test/api/marketing/unsubscribe');
    expect(url.searchParams.get('e')).toBe('reader@example.com');
    expect(verifyUnsubToken('reader@example.com', url.searchParams.get('t') ?? '')).toBe(true);
    expect(String(mail.html)).toContain(`href="${url.href}"`);
  });
});
