// P2 / P4 — marketing automation mail ignored the opt-out ledger and gave the
// reader no way out.
//
// `marketing_suppressions` holds every unsubscribe (/api/marketing/unsubscribe),
// bounce and complaint (the Resend webhook). The campaign sender reads it and
// footers every message with a signed unsubscribe link and List-Unsubscribe
// headers (lib/marketing/send.ts). The automation step runner did neither, and
// it is the ONE send path for every workflow: event-driven (the Resend webhook's
// email_opened / email_clicked, the public forms, onboarding, checkout) and
// scheduled (the daily runner). So a reader who clicked Unsubscribe in a
// campaign — a click Resend reports back as email.clicked — could be mailed
// "thanks for clicking" for it, and kept getting workflow mail after.
//
// Driven through the real Resend webhook and the real automations cron, the real
// dispatcher and runner, over an in-memory database. Only the provider is fake.
// Negative controls: before the fix each suppressed recipient below is mailed,
// and no mail carries List-Unsubscribe.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as Record<string, unknown>[],
  customers: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: h.customers, error: null }),
}));
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

const signingKey = Buffer.from('automation-consent-fixture-key');
let db: InMemorySupabase;

function seed(trigger: string) {
  db = createInMemorySupabase({
    uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']], resend_webhook_events: [['svix_id']] },
    rpc: { rate_limit_prune: () => null },
  });
  db.seed('marketing_automation_workflows', [{
    id: `wf-${trigger}`, trigger, status: 'active', deleted_at: null, run_count: 0,
    steps: [{ action: 'send_email' }],
  }]);
  db.seed('marketing_suppressions', [{ email: 'left@example.com', reason: 'unsubscribe' }]);
  h.db = db;
}

function clicked(recipient: string, id: string, link?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'email.clicked', data: link ? { to: [recipient], click: { link } } : { to: [recipient] } });
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new Request('https://bubaly.test/api/webhooks/resend', {
    method: 'POST', body,
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  });
}

async function webhook(recipient: string, id: string, link?: string) {
  const { POST } = await import('@/app/api/webhooks/resend/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest(clicked(recipient, id, link)));
}

async function cron() {
  const { GET } = await import('@/app/api/cron/automations/route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest('https://bubaly.test/api/cron/automations', {
    headers: { authorization: 'Bearer cron-fixture-secret' },
  }));
}

const customer = (familyId: string, ownerEmail: string) => ({
  familyId, name: 'Rivera', ownerEmail, memberCount: 2, plan: 'free', planLabel: 'Free', status: 'free',
  lifecycle: 'new', estLtvCents: 0, createdAt: '2026-10-01T00:00:00Z', lastActivityAt: '2026-10-11T00:00:00Z',
});

beforeEach(() => {
  // One fixed instant, so no case straddles a limiter window boundary.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules();
  h.sent = [];
  h.customers = [];
  vi.stubEnv('RESEND_WEBHOOK_SECRET', `whsec_${signingKey.toString('base64')}`);
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the Resend webhook does not mail someone who unsubscribed', () => {
  it('an email.clicked from an unsubscribed reader starts no mail', async () => {
    seed('email_clicked');
    const res = await webhook('Left@Example.com', 'msg_unsub_click');
    expect(res.status).toBe(200);
    expect(h.sent).toEqual([]);
    const [run] = db.table('marketing_automation_runs');
    expect(run.status, 'an opt-out honoured is a completed run, not a failure').toBe('completed');
    expect((run.metadata as { actions: string[] }).actions).toEqual(['send_email:suppressed']);
  });

  // The browser's GET of the Unsubscribe link writes the opt-out row; Resend's
  // email.clicked for that same click can arrive first. Then no suppression
  // exists yet, and only the link itself says this click was a way out.
  it('a click on the Unsubscribe link starts no mail, even before the opt-out row lands', async () => {
    seed('email_clicked');
    const res = await webhook('stays@example.com', 'msg_unsub_link',
      'https://bubaly.test/api/marketing/unsubscribe?e=stays%40example.com&t=abc');
    expect(res.status).toBe(200);
    expect(h.sent).toEqual([]);
    expect(db.table('marketing_automation_runs')).toEqual([]);
  });

  it('a click on any other link is still engagement (positive control)', async () => {
    seed('email_clicked');
    await webhook('stays@example.com', 'msg_other_link', 'https://bubaly.test/pricing?utm_source=mail');
    expect(h.sent).toHaveLength(1);
  });

  it('a reader who did not opt out is mailed, with the way out on the mail (positive control)', async () => {
    seed('email_clicked');
    await webhook('stays@example.com', 'msg_click');
    expect(h.sent).toHaveLength(1);
    const headers = h.sent[0].headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toMatch(/^<https:\/\/bubaly\.test\/api\/marketing\/unsubscribe\?e=stays%40example\.com&t=[0-9a-f]{64}>$/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(String(h.sent[0].html)).toContain('/api/marketing/unsubscribe?e=stays%40example.com');
  });
});

describe('the scheduled runner does not mail someone who unsubscribed', () => {
  it('skips the suppressed owner, mails the other, and does not re-try the skip every tick', async () => {
    seed('customer_created');
    h.customers = [customer('fam-left', 'left@example.com'), customer('fam-stays', 'stays@example.com')];

    const first = await cron();
    expect(first.status).toBe(200);
    expect(h.sent.map((m) => m.to)).toEqual(['stays@example.com']);
    const left = db.table('marketing_automation_runs').find((r) => r.subject_key === 'fam-left');
    expect(left?.status).toBe('completed');

    // A failed run is re-claimed on the next tick. A suppressed one must not be,
    // or the runner would re-read the opt-out forever and count it as a failure.
    const second = await cron();
    expect(second.status).toBe(200);
    expect(h.sent.map((m) => m.to)).toEqual(['stays@example.com']);
  });

  it('fails closed when the opt-out ledger cannot be read', async () => {
    seed('customer_created');
    h.customers = [customer('fam-stays', 'stays@example.com')];
    h.db = withFaults(db, (table) => (table === 'marketing_suppressions' ? { message: 'statement timeout' } : null));

    const res = await cron();
    expect(h.sent, 'an opt-out that could not be read is still an opt-out').toEqual([]);
    expect(res.status).toBe(502);
    expect(db.table('marketing_automation_runs')[0].status).toBe('failed');
  });
});
