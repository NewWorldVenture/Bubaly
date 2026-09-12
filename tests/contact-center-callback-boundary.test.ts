import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), admin: vi.fn(), submit: vi.fn(), sendSms: vi.fn(), concierge: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: mocks.submit }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/guardian/twilio', async original => ({ ...await original<typeof import('@/lib/guardian/twilio')>(), sendSms: mocks.sendSms,
  isTwilioConfigured: () => true,
  sendSmsWithReceipt: async (to: string, body: string) => { await mocks.sendSms(to, body); return { kind: 'accepted', messageSid: `SM${'1'.repeat(32)}`, providerStatus: 'queued' }; },
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));

const ORIGIN = 'https://bubaly.example';
const FAMILY = 'family-ours';
const TOKEN = 'contact-center-test-token';
const SMS = '/api/contact-center/sms';
const VOICEMAIL = `/api/contact-center/voice/transcription?familyId=${FAMILY}`;
let db: ReturnType<typeof createInMemorySupabase>;

function twilioRequest(path: string, fields: Record<string, string> = {}, valid = true) {
  const params = {
    To: '+15555550100', From: '+15555550200', Body: 'Please schedule a visit',
    MessageSid: 'SM_test_delivery', RecordingSid: 'RE_test_delivery', TranscriptionText: 'Please schedule a visit',
    ...fields,
  };
  const url = `${ORIGIN}${path}`;
  const signed = url + Object.keys(params).sort().map(key => key + params[key as keyof typeof params]).join('');
  const signature = valid ? createHmac('sha1', TOKEN).update(signed).digest('base64') : 'invalid';
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(params) });
}

/** Execute the actual middleware, then the actual route export with the same request. */
async function deliver(path: string, fields: Record<string, string> = {}, valid = true) {
  const req = twilioRequest(path, fields, valid);
  const { middleware } = await import('@/middleware');
  const gate = await middleware(req);
  expect(gate.headers.get('x-middleware-next'), 'Provider callback must reach its route-level signature guard').toBe('1');
  if (path.startsWith(SMS)) return (await import('@/app/api/contact-center/sms/route')).POST(req);
  if (path.startsWith('/api/contact-center/voice/transcription')) return (await import('@/app/api/contact-center/voice/transcription/route')).POST(req);
  return (await import('@/app/api/contact-center/voice/route')).POST(req);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'test-inbound-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  db = createInMemorySupabase({ uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' } } });
  db.seed('families', [{ id: FAMILY, name: 'Ours', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ id: 'channel-ours', family_id: FAMILY, phone_number: '+15555550100', email_local: 'ours', ai_concierge_enabled: false }]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'appointment', summary: 'A visit request', reply: 'Thank you', aiUsed: false });
  mocks.submit.mockImplementation(async (scope, input) => {
    const existing = db.table('ai_requests').find(row => row.family_id === scope.familyId && row.client_request_id === input.clientRequestId);
    if (!existing) db.table('ai_requests').push({ id: 'request-ours', family_id: scope.familyId, client_request_id: input.clientRequestId });
    return { ok: true, data: { requestId: 'request-ours', runId: 'run-ours', planId: null, outcome: 'plan', summary: 'Ready', redirect: null } };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Contact Center provider callbacks through middleware', () => {
  it.each([SMS, '/api/contact-center/voice', VOICEMAIL])('rejects invalid Twilio signatures for %s before household access', async path => {
    expect((await deliver(path, {}, false)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled();
  });

  it('lets inbound email reach its own secret guard', async () => {
    const req = new NextRequest(`${ORIGIN}/api/contact-center/email`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': 'wrong' }, body: '{}' });
    const { middleware } = await import('@/middleware');
    expect((await middleware(req)).headers.get('x-middleware-next')).toBe('1');
    expect((await (await import('@/app/api/contact-center/email/route')).POST(req)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(['/api/contact-center', '/api/contact-center/settings', '/api/contact-center/email/export', '/api/contact-center/sms-extra', '/api/contact-center/voice/transcription/private'])('keeps neighboring path %s protected', async path => {
    const { middleware } = await import('@/middleware');
    expect((await middleware(new NextRequest(`${ORIGIN}${path}`))).status).toBe(307);
  });

  it('returns a signed voice greeting with its transcription callback', async () => {
    const response = await deliver('/api/contact-center/voice');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${ORIGIN}${VOICEMAIL}`);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe.each([{ path: SMS, status: 200, channel: 'sms' }, { path: VOICEMAIL, status: 204, channel: 'voice' }])('$channel callback durable intake recovery', ({ path, status, channel }) => {
  it.each(['returned failure', 'thrown failure'])('returns 503 after %s, retries saved work, then deduplicates', async failure => {
    if (failure === 'returned failure') mocks.submit.mockResolvedValueOnce({ ok: false, error: 'Planner unavailable', retryable: true });
    else mocks.submit.mockRejectedValueOnce(new Error('Planner unavailable'));
    expect((await deliver(path)).status).toBe(503);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
    expect(db.table('ai_requests')).toHaveLength(0);
    const recovered = await deliver(path);
    expect(recovered.status).toBe(status);
    if (status === 204) expect(await recovered.text()).toBe('');
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(true);
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    const identities = mocks.submit.mock.calls.map(call => call[1].clientRequestId);
    expect(identities[0]).toBe(identities[1]);
    expect(identities[0]).toMatch(new RegExp(`^inbound:${channel}:`));
    expect((await deliver(path)).status).toBe(status);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(db.table('ai_requests')).toHaveLength(1);
  });

  it('retries after system family scope could not be read', async () => {
    // A missing family row is a no-scope outcome, before intake can run.
    db.table('families').splice(0);
    expect((await deliver(path)).status).toBe(503);
    expect(mocks.submit).not.toHaveBeenCalled();
    db.seed('families', [{ id: FAMILY, name: 'Ours', timezone: 'UTC' }]);
    expect((await deliver(path)).status).toBe(status);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(true);
  });

  it('refuses to acknowledge a duplicate when its required handled-state read fails', async () => {
    expect((await deliver(path)).status).toBe(status);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      const select = query.select.bind(query);
      query.select = ((...args: Parameters<typeof query.select>) => {
        if (table === 'family_inbox_messages' && args[0] === 'ai_handled') throw new Error('Read unavailable');
        return select(...args);
      }) as typeof query.select;
      return query;
    }) as typeof db.from);
    expect((await deliver(path)).status).toBe(503);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it('returns 503 for a returned database error during the replay read', async () => {
    expect((await deliver(path)).status).toBe(status);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      const select = query.select.bind(query);
      query.select = ((...args: Parameters<typeof query.select>) => {
        if (table === 'family_inbox_messages' && args[0] === 'ai_handled') {
          query.maybeSingle = (() => Promise.resolve({ data: null, error: { code: '08006', message: 'Read unavailable', details: null, hint: null }, count: null, status: 503, statusText: 'Service Unavailable' })) as typeof query.maybeSingle;
        }
        return select(...args);
      }) as typeof query.select;
      return query;
    }) as typeof db.from);
    expect((await deliver(path)).status).toBe(503);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it('recovers a failed handled stamp using the same persisted intake identity', async () => {
    const from = db.from.bind(db);
    const failedStamp = vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      const update = query.update.bind(query);
      query.update = ((...args: Parameters<typeof query.update>) => {
        if (table === 'family_inbox_messages' && args[0].ai_handled === true) {
          query.then = ((fulfilled, rejected) => Promise.resolve({ data: null, error: { code: '08006', message: 'Write unavailable', details: null, hint: null }, count: null, status: 503, statusText: 'Service Unavailable' }).then(fulfilled, rejected)) as typeof query.then;
        }
        return update(...args);
      }) as typeof query.update;
      return query;
    }) as typeof db.from);
    // Intake already persisted, so the existing helper acknowledges the work.
    expect((await deliver(path)).status).toBe(status);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
    expect(db.table('ai_requests')).toHaveLength(1);
    failedStamp.mockRestore();
    expect((await deliver(path)).status).toBe(status);
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(true);
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.submit.mock.calls[0][1].clientRequestId).toBe(mocks.submit.mock.calls[1][1].clientRequestId);
  });

  it('fails closed when the deduplicated message belongs to another family', async () => {
    db.seed('family_inbox_messages', [{ id: 'foreign-message', family_id: 'family-other', channel, provider_ref: channel === 'sms' ? 'SM_test_delivery' : 'RE_test_delivery', ai_handled: false }]);
    expect((await deliver(path)).status).toBe(503);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(db.table('family_inbox_messages')[0].ai_handled).toBe(false);
  });

  it('escalates an urgent delivery only once across provider replays', async () => {
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent call', reply: 'Received', aiUsed: false });
    expect((await deliver(path)).status).toBe(status);
    expect((await deliver(path)).status).toBe(status);
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(db.table('notifications')).toHaveLength(1);
  });

  it.each(['returned failure', 'thrown failure'])('alerts the human before a %s from planning, then retries without re-escalating', async failure => {
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent call', reply: 'Received', aiUsed: false });
    const server = await import('@/lib/contact-center/server');
    const handoff = vi.spyOn(server, 'routeInboundToPlanner');
    if (failure === 'returned failure') handoff.mockResolvedValueOnce({ routed: false, requestId: null, runId: null, paperworkItemId: null, reason: 'intake_failed' });
    else handoff.mockRejectedValueOnce(new Error('Planner unavailable'));
    expect((await deliver(path)).status).toBe(503);
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(db.table('notifications')).toHaveLength(1);
    expect((await deliver(path)).status).toBe(status);
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(db.table('notifications')).toHaveLength(1);
  });
});

describe('voicemail empty acknowledgements', () => {
  it.each([{ path: '/api/contact-center/voice/transcription?familyId=', fields: {} as Record<string, string> }, { path: VOICEMAIL, fields: { TranscriptionText: '  ' } }])('returns bodyless 204 for $path', async ({ path, fields }) => {
    const response = await deliver(path, fields);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled();
  });
});

describe('SMS auto-reply gap characterization (not delivery verification)', () => {
  it('currently returns another auto-reply and outbound row for an already handled callback', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const first = await deliver(SMS);
    const replay = await deliver(SMS);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await first.text()).toContain('<Message>Thank you</Message>');
    expect(await replay.text()).toContain('<Message>Thank you</Message>');
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'inbound')).toHaveLength(1);
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(2);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it.each(['STOP', 'START', 'HELP'])('leaves provider-handled %s controls out of concierge and planner work', async control => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const response = await deliver(SMS, { Body: control, OptOutType: control });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message>');
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('still rejects a forged opt-out callback before acknowledging it', async () => {
    expect((await deliver(SMS, { Body: 'STOP', OptOutType: 'STOP' }, false)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
