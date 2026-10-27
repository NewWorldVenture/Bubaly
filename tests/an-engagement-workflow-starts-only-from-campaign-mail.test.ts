import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers N10. An `email_opened` / `email_clicked` workflow fired on an
// open or click of ANY Bubaly email: every message goes out from the same
// sender and account with tracking on, and the webhook enrolled `to[0]` with
// no check that the event belonged to a marketing campaign. So a teen a parent
// invited by email, who never signed up, opened the invite and was sent "Glad
// that caught your eye". Only campaign-tagged mail is engagement now.
//
// The real Resend webhook, the real event dispatcher and the real step runner
// over the in-memory database; only the provider is fake.

const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as { to: string; subject: string }[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://bubaly.test',
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  getResend: () => ({
    emails: {
      send: async (message: { to: string; subject: string }) => {
        h.sent.push({ to: message.to, subject: message.subject });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));

const { POST } = await import('@/app/api/webhooks/resend/route');

const signingKey = Buffer.from('engagement-origin-fixture-key');
let db: InMemorySupabase;

function event(type: 'email.opened' | 'email.clicked', id: string, to: string, campaign?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const data: Record<string, unknown> = { to: [to] };
  if (type === 'email.clicked') data.click = { link: 'https://bubaly.test/join?invite=abc' };
  if (campaign) data.tags = [{ name: 'campaign', value: campaign }];
  const body = JSON.stringify({ type, data });
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${body}`).digest('base64');
  return POST(new NextRequest('https://bubaly.test/api/webhooks/resend', {
    method: 'POST', body,
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  }));
}

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']], resend_webhook_events: [['svix_id']] } });
  h.db = db;
  h.sent = [];
  db.seed('marketing_automation_workflows', [
    { id: 'wf-open', trigger: 'email_opened', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email' }] },
    { id: 'wf-click', trigger: 'email_clicked', status: 'active', deleted_at: null, run_count: 0, steps: [{ action: 'send_email' }] },
  ]);
  db.seed('marketing_suppressions', []);
  db.seed('marketing_email_campaigns', [{ id: 'cmp-1', opens: 0, clicks: 0 }]);
  vi.stubEnv('RESEND_WEBHOOK_SECRET', `whsec_${signingKey.toString('base64')}`);
  vi.stubEnv('INTERNAL_SECRET', 'engagement-origin-fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('an open or a click on mail that is not a campaign', () => {
  it.each(['email.opened', 'email.clicked'] as const)('%s of a family invite enrols no one and sends nothing', async (type) => {
    const res = await event(type, `msg_invite_${type}`, 'teen@example.com');
    expect(res.status).toBe(200);
    expect(h.sent, 'an invitee who never signed up was sent marketing mail').toEqual([]);
    expect(db.table('marketing_automation_runs')).toEqual([]);
  });
});

describe('an open or a click on campaign mail (control)', () => {
  it.each([
    ['email.opened', 'Glad that caught your eye 👀'],
    ['email.clicked', 'Picking up where you left off'],
  ] as const)('%s is engagement and starts its workflow once', async (type, subject) => {
    expect((await event(type, `msg_campaign_${type}`, 'reader@example.com', 'cmp-1')).status).toBe(200);
    expect(h.sent).toEqual([{ to: 'reader@example.com', subject }]);
    expect(db.table('marketing_automation_runs')).toEqual([expect.objectContaining({
      status: 'completed', subject_key: `${type === 'email.opened' ? 'email_opened' : 'email_clicked'}:cmp-1:reader@example.com`,
    })]);
  });
});
