// POST /api/webhooks/resend, driven end to end (Register B API-C4A25E75B606).
//
// What the neighbouring tests already prove, and this file does not repeat:
//  - forged ('v1,forged') and expired (>300s) signatures, an unset secret, and
//    malformed signed payloads, all refused before storage; receipt claims,
//    concurrent deliveries, stale reclaims, suppression/counter/finalisation
//    failures and the once-per-event counter (tests/resend-webhook-execution.test.ts);
//  - a placeholder secret from .env.example authenticates nothing
//    (tests/a-secret-copied-from-env-example-authenticates-nothing.test.ts);
//  - engagement workflows start only from campaign mail
//    (tests/an-engagement-workflow-starts-only-from-campaign-mail.test.ts) and not
//    for an unsubscribe click (tests/an-opted-out-address-gets-no-automation-mail.test.ts).
//
// What is added here, through the real handler over the in-memory database:
// a delivery with NO Svix headers (a browser session cookie is no credential),
// one signed with a different key, and a correctly signed header over a
// different body; the Svix rotation form (several `v1,` signatures) accepted
// when one matches; a valid open that counts on its own campaign only, read
// back from the tables, and a plain replay of that processed event that counts
// and enrols nothing twice; a bounce that suppresses only its own recipient and
// leaves another inbox's suppression row as it was; and a failed receipt read
// answered 503 with Retry-After and no internal text, nothing written.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase, withFaults, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ createServiceClient: vi.fn(), fireAutomationEvent: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: h.createServiceClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: h.fireAutomationEvent }));

import { POST } from '@/app/api/webhooks/resend/route';

const SIGNING_KEY = Buffer.from('fake-audit-resend-signing-key-0001');
const OTHER_KEY = Buffer.from('fake-audit-someone-elses-key-00002');
const CAMPAIGN_A = 'c0000000-0000-4000-8000-00000000000a';
const CAMPAIGN_B = 'c0000000-0000-4000-8000-00000000000b';
const INJECTED = 'injected receipt read failure: relation detail';

let db: InMemorySupabase;
let failReceiptRead = false;

/**
 * The in-memory client, with `marketing_suppressions` upserts resolving on the
 * table's primary key (`email`, 0021) as Postgres does for an upsert that names
 * no conflict target, and 0441's apply_resend_campaign_counter served from the
 * same tables.
 */
function fixture() {
  db = new InMemorySupabase({
    uniques: { resend_webhook_events: [['svix_id']], marketing_suppressions: [['email']] },
    rpc: {
      apply_resend_campaign_counter: (args, store) => {
        const receipt = store.table('resend_webhook_events').find((row) => row.svix_id === args.p_svix_id);
        if (!receipt || receipt.status !== 'processing' || receipt.received_at !== args.p_received_at) return 'claim_lost';
        if (receipt.counter_applied_at) return 'already_applied';
        receipt.counter_applied_at = new Date().toISOString();
        const campaign = store.table('marketing_email_campaigns').find((row) => row.id === args.p_campaign_id);
        if (!campaign) return 'no_campaign';
        const field = String(args.p_field);
        campaign[field] = Number(campaign[field] ?? 0) + 1;
        return 'applied';
      },
    },
  });
  db.seed('marketing_email_campaigns', [
    { id: CAMPAIGN_A, opens: 3, clicks: 0, bounces: 0, unsubscribes: 0 },
    { id: CAMPAIGN_B, opens: 7, clicks: 0, bounces: 0, unsubscribes: 0 },
  ]);
  db.seed('marketing_suppressions', [{ email: 'other-inbox@example.com', reason: 'unsubscribe', campaign_id: CAMPAIGN_B }]);
  const faulted = withFaults(db, (table, calls) =>
    failReceiptRead && table === 'resend_webhook_events' && calls[0]?.method === 'select' ? { message: INJECTED } : null);
  const client = new Proxy(faulted, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 'marketing_suppressions') return builder;
        return new Proxy(builder, {
          get(object, key) {
            const value = Reflect.get(object, key);
            if (key === 'upsert') return (row: Row) => value.call(object, row, { onConflict: 'email' });
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
      };
    },
  });
  h.createServiceClient.mockReturnValue(client);
}

function signed(event: unknown, options: {
  id?: string; key?: Buffer; headers?: 'none'; signatureHeader?: (good: string) => string; sentBody?: string; cookie?: string;
} = {}) {
  const id = options.id ?? 'msg_fake_audit_0001';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(event);
  const good = createHmac('sha256', options.key ?? SIGNING_KEY).update(`${id}.${timestamp}.${body}`).digest('base64');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.headers !== 'none') {
    headers['svix-id'] = id;
    headers['svix-timestamp'] = timestamp;
    headers['svix-signature'] = options.signatureHeader ? options.signatureHeader(good) : `v1,${good}`;
  }
  if (options.cookie) headers.cookie = options.cookie;
  return new NextRequest('https://app.example.com/api/webhooks/resend', { method: 'POST', body: options.sentBody ?? body, headers });
}

const opened = (campaign: string, to = 'Reader-A@Example.com') => ({ type: 'email.opened', data: { to: [to], tags: { campaign } } });
const campaign = (id: string) => db.table('marketing_email_campaigns').find((row) => row.id === id);

beforeEach(() => {
  failReceiptRead = false;
  vi.stubEnv('RESEND_WEBHOOK_SECRET', `whsec_${SIGNING_KEY.toString('base64')}`);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.fireAutomationEvent.mockReset().mockResolvedValue({ workflows: 0, emails: 0, failures: 0 });
  h.createServiceClient.mockReset();
  fixture();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function expectNothingWritten() {
  expect(db.table('resend_webhook_events')).toEqual([]);
  expect(campaign(CAMPAIGN_A)?.opens).toBe(3);
  expect(campaign(CAMPAIGN_B)?.opens).toBe(7);
  expect(db.table('marketing_suppressions')).toHaveLength(1);
  expect(h.fireAutomationEvent).not.toHaveBeenCalled();
}

describe('API-C4A25E75B606 who may deliver an email event', () => {
  it('API-C4A25E75B606 a delivery with no Svix headers, even one carrying a session cookie, is 401 and opens no database client', async () => {
    const response = await POST(signed(opened(CAMPAIGN_A), { headers: 'none', cookie: 'sb-access-token=fake-parent-session' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'resend.invalidSignature' });
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('API-C4A25E75B606 a delivery signed with a different key is 401 and writes nothing', async () => {
    const response = await POST(signed(opened(CAMPAIGN_A), { key: OTHER_KEY }));
    expect(response.status).toBe(401);
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('API-C4A25E75B606 a correctly signed header over a different body is 401 and writes nothing', async () => {
    const response = await POST(signed(opened(CAMPAIGN_A), { sentBody: JSON.stringify(opened(CAMPAIGN_B)) }));
    expect(response.status).toBe(401);
    expectNothingWritten();
  });

  it('API-C4A25E75B606 the Svix rotation form is accepted when one of its signatures matches', async () => {
    const response = await POST(signed(opened(CAMPAIGN_A), { signatureHeader: (good) => `v1,${Buffer.from('stale').toString('base64')} v1,${good}` }));
    expect(response.status).toBe(200);
    expect(campaign(CAMPAIGN_A)?.opens).toBe(4);
  });
});

describe('API-C4A25E75B606 a correctly signed event, end to end', () => {
  it('API-C4A25E75B606 an open counts on its own campaign only, finishes its receipt and enrols the lower-cased recipient once', async () => {
    const response = await POST(signed(opened(CAMPAIGN_A)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(campaign(CAMPAIGN_A)?.opens).toBe(4);
    expect(campaign(CAMPAIGN_B)?.opens).toBe(7);
    const receipts = db.table('resend_webhook_events');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ svix_id: 'msg_fake_audit_0001', event_type: 'email.opened', status: 'processed', error: null });
    expect(h.fireAutomationEvent).toHaveBeenCalledOnce();
    expect(h.fireAutomationEvent.mock.calls[0][1]).toMatchObject({
      trigger: 'email_opened', email: 'reader-a@example.com', context: { campaignId: CAMPAIGN_A },
    });
  });

  it('API-C4A25E75B606 a replay of a processed event is acknowledged as a duplicate and counts and enrols nothing again', async () => {
    const event = opened(CAMPAIGN_A);
    expect((await POST(signed(event))).status).toBe(200);
    const replay = await POST(signed(event));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    expect(campaign(CAMPAIGN_A)?.opens).toBe(4);
    expect(db.table('resend_webhook_events')).toHaveLength(1);
    expect(h.fireAutomationEvent).toHaveBeenCalledOnce();
  });

  it('API-C4A25E75B606 a bounce suppresses only its own recipient and leaves another inbox\'s suppression row as it was', async () => {
    const before = structuredClone(db.table('marketing_suppressions'));
    const response = await POST(signed({ type: 'email.bounced', data: { to: ['Bounced-A@Example.com'], tags: { campaign: CAMPAIGN_A } } }));
    expect(response.status).toBe(200);
    const rows = db.table('marketing_suppressions');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.email === 'bounced-a@example.com')).toMatchObject({ reason: 'bounce', campaign_id: CAMPAIGN_A });
    expect(rows.filter((row) => row.email === 'other-inbox@example.com')).toEqual(before);
    expect(campaign(CAMPAIGN_A)?.bounces).toBe(1);
    expect(campaign(CAMPAIGN_B)?.bounces).toBe(0);
    expect(h.fireAutomationEvent).not.toHaveBeenCalled();
  });
});

describe('API-C4A25E75B606 a failed read', () => {
  it('API-C4A25E75B606 a failed receipt read is 503 with Retry-After and no internal text, and nothing is claimed, counted or suppressed', async () => {
    failReceiptRead = true;
    const response = await POST(signed({ type: 'email.complained', data: { to: ['complainer@example.com'], tags: { campaign: CAMPAIGN_A } } }));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'resend.webhookStorageUnavailable' });
    expect(text).not.toContain('injected');
    expectNothingWritten();
    expect(campaign(CAMPAIGN_A)?.unsubscribes).toBe(0);
  });
});
