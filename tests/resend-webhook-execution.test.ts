import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn(), fireAutomationEvent: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: mocks.fireAutomationEvent }));
vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: [
    { ownerEmail: 'fixture@example.test' }, { ownerEmail: 'eligible@example.test' },
  ], error: null }),
}));

import { POST } from '@/app/api/webhooks/resend/route';
import { resolveRecipients } from '@/lib/marketing/send';

const signingKey = Buffer.from('resend-execution-fixture-key');
const eventId = 'msg_resend_execution_fixture';
const failure = { data: null, error: { code: 'XX000', message: 'Injected persistence failure' } };
type Operation = 'read' | 'insert' | 'update' | 'upsert' | 'rpc';
type Attempt = { table: string; operation: Operation; payload?: Row };
type Interceptor = (attempt: Attempt) => Promise<typeof failure | null> | typeof failure | null;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// The shared fake applies filters, uniqueness and stored mutations. This wrapper
// only injects failures/pauses before execution, so retry and race assertions read
// the resulting database state instead of checking query strings.
function fixture() {
  const db = new InMemorySupabase({ uniques: {
    resend_webhook_events: [['svix_id']], marketing_suppressions: [['email']],
  } });
  const attempts: Attempt[] = [];
  let intercept: Interceptor = () => null;
  // resend_apply_campaign_counter (0340), emulated with the SQL's semantics:
  // mark the event's counter applied only if it is not yet, then increment the
  // campaign atomically; a non-UUID campaign tag is an unknown campaign. The
  // SQL itself is proved by docs/audit/resend-counter-applied-once-check.sql.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function applyCounter(args: Row) {
    const field = String(args.p_field);
    if (!['opens', 'clicks', 'bounces', 'unsubscribes'].includes(field)) return { data: null, error: { code: '22023', message: 'unknown counter' } };
    if (!UUID.test(String(args.p_campaign_id))) return { data: 'no_campaign', error: null };
    const event = db.table('resend_webhook_events').find((row) => row.svix_id === args.p_svix_id);
    if (!event) return { data: null, error: { code: 'P0002', message: 'no claimed event' } };
    if (event.counter_applied_at) return { data: 'already_applied', error: null };
    event.counter_applied_at = new Date().toISOString();
    const campaign = db.table('marketing_email_campaigns').find((row) => row.id === args.p_campaign_id);
    if (!campaign) return { data: 'no_campaign', error: null };
    campaign[field] = ((campaign[field] as number | null) ?? 0) + 1;
    return { data: 'applied', error: null };
  }
  const client = {
    async rpc(name: string, args: Row) {
      const attempt = { table: `rpc:${name}`, operation: 'rpc' as Operation, payload: args };
      attempts.push(attempt);
      const injected = await intercept(attempt);
      if (injected) return injected;
      if (name !== 'resend_apply_campaign_counter') return { data: null, error: { code: 'PGRST202', message: `unknown function ${name}` } };
      return applyCounter(args);
    },
    from(table: string) {
      const builder = db.from(table);
      let operation: Operation = 'read';
      let payload: Row | undefined;
      async function run(single: boolean) {
        const attempt = { table, operation, payload };
        attempts.push(attempt);
        const injected = await intercept(attempt);
        if (injected) return injected;
        return single ? builder.maybeSingle() : await builder;
      }
      const query = {
        select(columns: string) { builder.select(columns); return query; },
        eq(column: string, value: unknown) { builder.eq(column, value); return query; },
        // The counter write guards on the value it read, and a never-counted
        // column is NULL rather than 0, so both comparisons must reach the fake.
        is(column: string, value: unknown) { builder.is(column, value); return query; },
        insert(value: Row) { operation = 'insert'; payload = value; builder.insert(value); return query; },
        update(value: Row) { operation = 'update'; payload = value; builder.update(value); return query; },
        upsert(value: Row) {
          operation = 'upsert'; payload = value;
          // PostgreSQL's default conflict target is the table's primary key.
          builder.upsert(value, { onConflict: 'email' }); return query;
        },
        maybeSingle: () => run(true),
        then: <T>(resolve: (value: Awaited<ReturnType<typeof run>>) => T, reject?: (error: unknown) => T) =>
          run(false).then(resolve, reject),
      };
      return query;
    },
  };
  mocks.createServiceClient.mockReturnValue(client);
  return {
    db, attempts,
    intercept: (value: Interceptor) => { intercept = value; },
    event: () => db.table('resend_webhook_events')[0],
    suppressions: () => db.table('marketing_suppressions'),
  };
}

function signedRequest(type = 'email.complained', options: {
  id?: string; recipients?: string[]; campaign?: string; timestamp?: number; signature?: string;
  payload?: unknown;
} = {}) {
  const id = options.id ?? eventId;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify('payload' in options ? options.payload : { type, data: {
    to: options.recipients ?? ['Fixture@Example.test'],
    ...(options.campaign ? { tags: [{ name: 'campaign', value: options.campaign }] } : {}),
  } });
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new NextRequest('https://fixture.example.test/api/webhooks/resend', {
    method: 'POST', body,
    headers: {
      'svix-id': id, 'svix-timestamp': timestamp,
      'svix-signature': options.signature ?? `v1,${signature}`,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  vi.stubEnv('RESEND_WEBHOOK_SECRET', `whsec_${signingKey.toString('base64')}`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.fireAutomationEvent.mockResolvedValue({ workflows: 0, emails: 0, failures: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('signed Resend suppression and durable receipt execution', () => {
  it('rejects forged and expired signatures before touching storage', async () => {
    const f = fixture();
    expect((await POST(signedRequest('email.complained', { signature: 'v1,forged' }))).status).toBe(401);
    expect((await POST(signedRequest('email.complained', { timestamp: Math.floor(Date.now() / 1000) - 301 }))).status).toBe(401);
    expect(f.attempts).toEqual([]);
  });

  it.each([
    null, [], 42, true, 'email.complained', {}, { type: null },
    { type: 'email.complained', data: null },
    { type: 'email.complained', data: { to: 42 } },
    { type: 'email.complained', data: { to: [42] } },
    { type: 'email.complained', data: { to: [] } },
    { type: 'email.complained', data: { to: '   ' } },
    { type: 'email.complained', data: {} },
    { type: 'email.clicked', data: { tags: { campaign: 42 } } },
    { type: 'email.clicked', data: { tags: [{ name: 'campaign', value: 42 }] } },
  ])('rejects a malformed signed event before claiming it: %j', async (payload) => {
    const f = fixture();
    expect((await POST(signedRequest('email.complained', { payload }))).status).toBe(400);
    expect(f.attempts).toEqual([]);
    expect(f.db.table('resend_webhook_events')).toHaveLength(0);
  });

  it('acknowledges an unsupported but well-formed event after persisting its receipt', async () => {
    const f = fixture();
    expect((await POST(signedRequest('email.sent', { payload: { type: 'email.sent', data: { extra_provider_field: true } } }))).status).toBe(200);
    expect(f.event().status).toBe('processed');
    expect(f.suppressions()).toHaveLength(0);
  });

  it.each(['email.bounced', 'email.opened'])('accepts the documented Resend tag record for %s and attributes the campaign', async (type) => {
    const f = fixture();
    f.db.seed('marketing_email_campaigns', [{ id: '00000000-0000-4000-8000-0000000c0001', bounces: 0, opens: 0 }]);
    const event = {
      type, data: { to: ['fixture@example.test'], tags: { campaign: '00000000-0000-4000-8000-0000000c0001', category: 'fixture' } },
    };
    expect((await POST(signedRequest(type, { payload: event }))).status).toBe(200);
    expect(f.event().status).toBe('processed');
    expect(f.db.table('marketing_email_campaigns')[0][type === 'email.bounced' ? 'bounces' : 'opens']).toBe(1);
    if (type === 'email.bounced') expect(f.suppressions()[0].campaign_id).toBe('00000000-0000-4000-8000-0000000c0001');
    else expect(mocks.fireAutomationEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      trigger: 'email_opened', context: { campaignId: '00000000-0000-4000-8000-0000000c0001' },
    }));
  });

  it('only one first delivery can insert the receipt; the concurrent loser must retry', async () => {
    const f = fixture();
    const releaseInserts = deferred();
    let inserts = 0;
    f.intercept(async (a) => {
      if (a.table === 'resend_webhook_events' && a.operation === 'insert') {
        if (++inserts === 2) releaseInserts.resolve();
        await releaseInserts.promise;
      }
      return null;
    });
    const results = await Promise.all([POST(signedRequest()), POST(signedRequest())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 503]);
    expect(f.db.table('resend_webhook_events')).toHaveLength(1);
    expect(f.attempts.filter(a => a.table === 'marketing_suppressions')).toHaveLength(1);
    expect(f.event().status).toBe('processed');
  });

  it.each(['email.bounced', 'email.complained'])('retries a failed %s suppression and acknowledges only the persisted result', async (type) => {
    const f = fixture();
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'marketing_suppressions' && failOnce) { failOnce = false; return failure; }
      return null;
    });
    const first = await POST(signedRequest(type));
    expect(first.status).toBe(503);
    expect(first.headers.get('Retry-After')).toBe('30');
    expect(f.event().status).toBe('error');
    expect(f.suppressions()).toHaveLength(0);

    expect((await POST(signedRequest(type))).status).toBe(200);
    expect(f.event().status).toBe('processed');
    expect(f.suppressions()).toMatchObject([{ email: 'fixture@example.test', reason: type === 'email.bounced' ? 'bounce' : 'complaint' }]);
    const calls = f.attempts.filter(a => a.table === 'marketing_suppressions').length;
    const duplicate = await POST(signedRequest(type));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect(f.attempts.filter(a => a.table === 'marketing_suppressions')).toHaveLength(calls);
  });

  it('retries a thrown request failure without stranding the receipt', async () => {
    const f = fixture();
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'marketing_suppressions' && failOnce) { failOnce = false; throw new Error('Injected network rejection'); }
      return null;
    });
    expect((await POST(signedRequest())).status).toBe(503);
    expect(f.event().status).toBe('error');
    expect((await POST(signedRequest())).status).toBe(200);
    expect(f.suppressions()).toHaveLength(1);
  });

  it('excludes the successfully retried complaint recipient from the actual campaign audience resolver', async () => {
    const f = fixture();
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'marketing_suppressions' && failOnce) { failOnce = false; return failure; }
      return null;
    });
    expect((await POST(signedRequest())).status).toBe(503);
    expect((await POST(signedRequest())).status).toBe(200);
    const recipients = await resolveRecipients(f.db as unknown as SupabaseClient<Database>, { segment_id: null });
    expect(recipients).toEqual(['eligible@example.test']);
  });

  it('replays a partially suppressed recipient list without duplicate rows', async () => {
    const f = fixture();
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'marketing_suppressions' && a.payload?.email === 'second@example.test' && failOnce) {
        failOnce = false; return failure;
      }
      return null;
    });
    const options = { recipients: ['first@example.test', 'second@example.test'] };
    expect((await POST(signedRequest('email.bounced', options))).status).toBe(503);
    expect(f.suppressions()).toHaveLength(1);
    expect((await POST(signedRequest('email.bounced', options))).status).toBe(200);
    expect(f.suppressions()).toHaveLength(2);
    expect(f.event().status).toBe('processed');
  });

  it('persists suppression before a campaign counter failure and retries the receipt', async () => {
    const f = fixture();
    f.db.seed('marketing_email_campaigns', [{ id: '00000000-0000-4000-8000-0000000c0001', bounces: 0 }]);
    let failOnce = true;
    f.intercept((a) => {
      if (a.operation === 'rpc' && failOnce) { failOnce = false; return failure; }
      return null;
    });
    expect((await POST(signedRequest('email.bounced', { campaign: '00000000-0000-4000-8000-0000000c0001' }))).status).toBe(503);
    expect(f.suppressions()).toHaveLength(1);
    expect(f.event().status).toBe('error');
    expect((await POST(signedRequest('email.bounced', { campaign: '00000000-0000-4000-8000-0000000c0001' }))).status).toBe(200);
    expect(f.suppressions()).toHaveLength(1);
    expect(f.db.table('marketing_email_campaigns')[0].bounces).toBe(1);
  });

  it('does not acknowledge failed finalization, and can repeat the idempotent suppression', async () => {
    const f = fixture();
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'resend_webhook_events' && a.payload?.status === 'processed' && failOnce) { failOnce = false; return failure; }
      return null;
    });
    expect((await POST(signedRequest())).status).toBe(503);
    expect(f.event().status).toBe('error');
    expect(f.suppressions()).toHaveLength(1);
    expect((await POST(signedRequest())).status).toBe(200);
    expect(f.event().status).toBe('processed');
    expect(f.suppressions()).toHaveLength(1);
  });

  it('keeps retrying when error-state persistence also fails, then reclaims the stale receipt', async () => {
    const f = fixture();
    f.intercept((a) => a.table === 'marketing_suppressions' || a.payload?.status === 'error' ? failure : null);
    expect((await POST(signedRequest())).status).toBe(503);
    expect(f.event().status).toBe('processing');
    f.intercept(() => null);
    expect((await POST(signedRequest())).status).toBe(503);
    expect(f.suppressions()).toHaveLength(0);
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await POST(signedRequest())).status).toBe(200);
    expect(f.suppressions()).toHaveLength(1);
    expect(f.event().status).toBe('processed');
  });

  it('does not acknowledge another worker while its suppression is unfinished', async () => {
    const f = fixture();
    const entered = deferred();
    const resume = deferred();
    f.intercept(async (a) => {
      if (a.table === 'marketing_suppressions') { entered.resolve(); await resume.promise; }
      return null;
    });
    const first = POST(signedRequest());
    await entered.promise;
    expect((await POST(signedRequest())).status).toBe(503);
    expect(f.suppressions()).toHaveLength(0);
    resume.resolve();
    expect((await first).status).toBe(200);
    expect((await POST(signedRequest())).status).toBe(200);
    expect(f.attempts.filter(a => a.table === 'marketing_suppressions')).toHaveLength(1);
  });

  it('allows only one concurrent worker to reclaim the same stale receipt', async () => {
    const f = fixture();
    f.db.seed('resend_webhook_events', [{ svix_id: eventId, status: 'processing', received_at: new Date(Date.now() - 11 * 60_000).toISOString() }]);
    const releaseClaims = deferred();
    let claimAttempts = 0;
    f.intercept(async (a) => {
      if (a.operation === 'update' && a.payload?.status === 'processing') {
        if (++claimAttempts === 2) releaseClaims.resolve();
        await releaseClaims.promise;
      }
      return null;
    });
    const results = await Promise.all([POST(signedRequest()), POST(signedRequest())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 503]);
    expect(f.event().status).toBe('processed');
    expect(f.attempts.filter(a => a.table === 'marketing_suppressions')).toHaveLength(1);
  });

  it.each([false, true])('an old worker cannot overwrite a newer completed claim (old suppression fails: %s)', async (oldFails) => {
    const f = fixture();
    const entered = deferred();
    const resume = deferred();
    let pauseFirst = true;
    f.intercept(async (a) => {
      if (a.table === 'marketing_suppressions' && pauseFirst) {
        pauseFirst = false; entered.resolve(); await resume.promise;
        if (oldFails) return failure;
      }
      return null;
    });
    const oldWorker = POST(signedRequest());
    await entered.promise;
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await POST(signedRequest())).status).toBe(200);
    const newReceipt = { ...f.event() };
    resume.resolve();
    expect((await oldWorker).status).toBe(503);
    expect(f.event()).toEqual(newReceipt);
    expect(f.event().status).toBe('processed');
    expect(f.suppressions()).toHaveLength(1);
  });
});

// EMAIL-002. Two counter defects, closed together by 0340's
// resend_apply_campaign_counter, which marks the event's counter applied and
// increments the campaign in one transaction.
//   * Lost update: the claim serialises by svix_id — one EVENT — so two events
//     for the same campaign run concurrently by design, and read-then-write kept
//     only one of them. The increment is now atomic in SQL.
//   * Double count: the counter moved before the receipt was finalised, so a
//     failed finalisation, retried by the provider, counted one open twice.
describe('campaign counters: every event counted, each exactly once', () => {
  const campaign = '00000000-0000-4000-8000-0000000c0002';

  function withCampaign(counters: Row) {
    const f = fixture();
    f.db.seed('marketing_email_campaigns', [{ id: campaign, ...counters }]);
    return f;
  }

  it('counts a retried event once when its finalisation failed the first time', async () => {
    const f = withCampaign({ opens: 5 });
    let failOnce = true;
    f.intercept((a) => {
      if (a.table === 'resend_webhook_events' && a.payload?.status === 'processed' && failOnce) { failOnce = false; return failure; }
      return null;
    });
    expect((await POST(signedRequest('email.opened', { id: 'msg_retry', campaign }))).status, 'finalisation failed').toBe(503);
    expect(f.db.table('marketing_email_campaigns')[0].opens).toBe(6);
    expect((await POST(signedRequest('email.opened', { id: 'msg_retry', campaign }))).status, 'provider retry').toBe(200);
    expect(f.db.table('marketing_email_campaigns')[0].opens, 'one open, counted once; 7 is the double count').toBe(6);
    expect(f.event().status).toBe('processed');
  });

  it('counts both of two events that interleave on the same campaign', async () => {
    const f = withCampaign({ opens: 5 });
    // Hold A's counter application while B completes. With read-then-write in the
    // route this lost one of the two; the increment now happens in one SQL
    // statement, so A applies against whatever B left behind.
    const reached = deferred();
    const release = deferred();
    let first = true;
    f.intercept(async (attempt) => {
      if (attempt.operation === 'rpc' && first) {
        first = false;
        reached.resolve();
        await release.promise;
      }
      return null;
    });

    const slow = POST(signedRequest('email.opened', { id: 'msg_a', campaign }));
    await reached.promise;
    expect((await POST(signedRequest('email.opened', { id: 'msg_b', campaign }))).status).toBe(200);
    expect(f.db.table('marketing_email_campaigns')[0].opens, 'B counted').toBe(6);
    release.resolve();
    expect((await slow).status).toBe(200);
    expect(f.db.table('marketing_email_campaigns')[0].opens, 'two opens must count as two').toBe(7);
  });

  it('counts an event against a column that has never been counted', async () => {
    const f = withCampaign({ opens: null });
    expect((await POST(signedRequest('email.opened', { id: 'msg_null', campaign }))).status).toBe(200);
    expect(f.db.table('marketing_email_campaigns')[0].opens).toBe(1);
  });

  it('fails the event back to the provider when the counter cannot be applied, and counts it once on retry', async () => {
    const f = withCampaign({ opens: 5 });
    let failOnce = true;
    f.intercept((attempt) => (attempt.operation === 'rpc' && failOnce ? (failOnce = false, failure) : null));
    const response = await POST(signedRequest('email.opened', { id: 'msg_lost', campaign }));
    expect(response.status, 'a 200 here would tell the provider to stop retrying').toBe(503);
    expect(f.event().status).toBe('error');
    expect((await POST(signedRequest('email.opened', { id: 'msg_lost', campaign }))).status).toBe(200);
    expect(f.db.table('marketing_email_campaigns')[0].opens).toBe(6);
  });

  it('passes the event, the campaign and the counter to the database, and nothing else', async () => {
    const f = withCampaign({ opens: 0 });
    await POST(signedRequest('email.opened', { id: 'msg_args', campaign }));
    expect(f.attempts.filter((a) => a.operation === 'rpc').map((a) => a.payload)).toEqual([
      { p_svix_id: 'msg_args', p_campaign_id: campaign, p_field: 'opens' },
    ]);
    // No read-modify-write of the campaign from the route any more.
    expect(f.attempts.some((a) => a.table === 'marketing_email_campaigns')).toBe(false);
  });

  it('leaves an unknown campaign alone without failing the event', async () => {
    const f = fixture();
    const response = await POST(signedRequest('email.opened', { id: 'msg_none', campaign: 'no-such-campaign' }));
    expect(response.status).toBe(200);
    expect(f.event().status).toBe('processed');
  });
});
