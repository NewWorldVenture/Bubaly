import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), admin: vi.fn(), submit: vi.fn(), sendSms: vi.fn(), concierge: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: mocks.submit }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en' } }) }));
vi.mock('@/lib/guardian/twilio', async original => ({ ...await original<typeof import('@/lib/guardian/twilio')>(), sendSms: mocks.sendSms,
  isTwilioConfigured: () => true,
  sendSmsWithReceipt: async (to: string, body: string) => { await mocks.sendSms(to, body); return { kind: 'accepted', messageSid: `SM${'1'.repeat(32)}`, providerStatus: 'queued' }; },
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));

const ORIGIN = 'https://bubaly.example';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'contact-center-test-token';
const SMS = '/api/contact-center/sms';
const SMS_SID = `SM${'2'.repeat(32)}`;
const VOICEMAIL = `/api/contact-center/voice/transcription?familyId=${FAMILY}`;
let db: ReturnType<typeof createInMemorySupabase>;

function twilioRequest(path: string, fields: Record<string, string> = {}, valid = true) {
  const params = {
    To: '+15555550100', From: '+15555550200', Body: 'Please schedule a visit',
    MessageSid: SMS_SID, RecordingSid: 'RE_test_delivery', TranscriptionText: 'Please schedule a visit',
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
  vi.stubEnv('TWILIO_ACCOUNT_SID', '');
  vi.stubEnv('CONTACT_CENTER_INBOUND_SECRET', 'test-inbound-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  db = createInMemorySupabase({ uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new', occurred_at: '2026-09-12T00:00:00.000Z' } } });
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

  it.each(['/api/contact-center', '/api/contact-center/settings', '/api/contact-center/email/export', '/api/contact-center/sms-extra', '/api/contact-center/sms/status/private', '/api/contact-center/sms/status-extra', '/api/contact-center/voice/transcription/private'])('keeps neighboring path %s protected', async path => {
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
    db.seed('family_inbox_messages', [{ id: 'foreign-message', family_id: 'family-other', channel, provider_ref: channel === 'sms' ? SMS_SID : 'RE_test_delivery', ai_handled: false }]);
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

describe('SMS automatic reply reservation (not provider delivery verification)', () => {
  it('binds both provider callback attributes to the reserved token and saved account', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const accountSid = `AC${'4'.repeat(32)}`;
    const response = await deliver(SMS, { AccountSid: accountSid });
    expect(response.status).toBe(200);
    const body = await response.text();
    const saved = db.table('ai_tool_calls').find(row => row.tool_name === 'contact_center.sms_reply')!;
    const outputs = saved.outputs as { emissionToken: string; emissionAccountSid: string; delivery?: unknown };
    const target = `${ORIGIN}${SMS}/status?receipt=${saved.id}&amp;token=${outputs.emissionToken}`;
    expect(body).toContain(`action="${target}" statusCallback="${target}" method="POST"`);
    expect(outputs.emissionAccountSid).toBe(accountSid);
    expect(outputs.delivery).toBeUndefined();
    expect(body).toContain('>Thank you</Message>');
  });

  it.each(['wrong', `AC${'5'.repeat(32)}`])('rejects malformed or mismatched callback account %s before household access', async accountSid => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'4'.repeat(32)}`);
    expect((await deliver(SMS, { AccountSid: accountSid })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('uses the configured account snapshot when an otherwise signed inbound callback omits it', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'4'.repeat(32)}`);
    expect((await deliver(SMS)).status).toBe(200);
    const saved = db.table('ai_tool_calls').find(row => row.tool_name === 'contact_center.sms_reply')!;
    expect(saved.outputs).toMatchObject({ emissionAccountSid: `AC${'4'.repeat(32)}` });
  });

  it('does not consume a reply reservation for invalid callback origin configuration', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://bubaly.example/path?untrusted=1');
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const response = await deliver(SMS);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('<Message');
    const saved = db.table('ai_tool_calls').find(row => row.tool_name === 'contact_center.sms_reply')!;
    expect(saved.outputs).toMatchObject({ phase: 'queued', emissionToken: null });
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(0);
  });

  it('returns only the first automatic reply and keeps one outbound row across callback replay', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const first = await deliver(SMS);
    const replay = await deliver(SMS);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await first.text()).toContain('>Thank you</Message>');
    expect(await replay.text()).not.toContain('<Message');
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'inbound')).toHaveLength(1);
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(1);
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.concierge).toHaveBeenCalledOnce();
  });

  it('uses the first saved candidate after planning fails instead of classifying the replay again', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    mocks.submit.mockResolvedValueOnce({ ok: false, error: 'Planner unavailable', retryable: true });
    const failed = await deliver(SMS);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('<Message');
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(0);
    mocks.concierge.mockResolvedValue({ intent: 'spam', summary: 'Changed classification', reply: 'Changed reply', aiUsed: false });
    const retry = await deliver(SMS);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('>Thank you</Message>');
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(db.table('ai_requests')).toHaveLength(1);
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'inbound')[0].ai_intent).toBe('appointment');
  });

  it('permits only one reply when signed callbacks overlap', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const responses = await Promise.all([deliver(SMS), deliver(SMS)]);
    const bodies = await Promise.all(responses.map(response => response.text()));
    expect(bodies.filter(body => body.includes('<Message'))).toHaveLength(1);
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(1);
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'inbound')).toHaveLength(1);
    const replay = await deliver(SMS);
    expect(replay.status).toBe(200);
    expect(await replay.text()).not.toContain('<Message');
  });

  it('suppresses a prepared reply when the concierge is disabled during planner processing', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const server = await import('@/lib/contact-center/server');
    vi.spyOn(server, 'routeInboundToPlanner').mockImplementationOnce(async () => {
      db.table('family_contact_channels')[0].ai_concierge_enabled = false;
      return { routed: false, requestId: null, runId: null, paperworkItemId: null, reason: 'not_actionable' };
    });
    const response = await deliver(SMS);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message');
    expect(db.table('family_inbox_messages').filter(row => row.direction === 'outbound')).toHaveLength(0);
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    expect(await (await deliver(SMS)).text()).not.toContain('<Message');
    expect(mocks.concierge).toHaveBeenCalledOnce();
  });

  it('does not infer an unsent reply from a legacy inbound message without a receipt', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    db.seed('family_inbox_messages', [{ id: '99999999-9999-4999-8999-999999999999', family_id: FAMILY, channel: 'sms', direction: 'inbound',
      from_addr: '+15555550200', to_addr: '+15555550100', subject: null, body: 'Please schedule a visit',
      provider_ref: SMS_SID, ai_handled: true, ai_summary: 'Saved visit', ai_intent: 'appointment', status: 'read' }]);
    const response = await deliver(SMS);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message');
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('family_inbox_messages')[0].status).toBe('read');
  });

  it.each(['', 'not-a-provider-sid'])('retains intake without creating a reply occasion for SID %s', async sid => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const response = await deliver(SMS, { MessageSid: sid });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message');
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('family_inbox_messages')[0].direction).toBe('inbound');
    expect(db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.sms_reply')).toHaveLength(0);
  });

  it('rejects conflicting signed SID aliases before household access', async () => {
    expect((await deliver(SMS, { SmsSid: `SM${'3'.repeat(32)}` })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('rejects duplicate form fields before household access', async () => {
    const req = twilioRequest(SMS);
    const body = await req.text();
    const ambiguous = new NextRequest(req.url, { method: 'POST', headers: req.headers, body: `${body}&Body=another-message` });
    expect((await (await import('@/app/api/contact-center/sms/route')).POST(ambiguous)).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([
    ['&__proto__=first', 401],
    ['&__proto__=first&__proto__=second', 400],
  ])('preserves prototype-named fields in signature and duplicate checks: %s', async (suffix, status) => {
    const req = twilioRequest(SMS);
    const body = await req.text();
    const ambiguous = new NextRequest(req.url, { method: 'POST', headers: req.headers, body: body + suffix });
    expect((await (await import('@/app/api/contact-center/sms/route')).POST(ambiguous)).status).toBe(status);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('uses the saved urgent acknowledgement without repeating the fallback notification', async () => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    db.table('family_contact_channels')[0].forward_to_phone = '+15555550300';
    mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent help', reply: 'Unsupported delivery claim', aiUsed: false });
    const first = await deliver(SMS);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('>contactUrgent.replySaved</Message>');
    expect(await (await deliver(SMS)).text()).not.toContain('<Message');
    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(db.table('notifications')).toHaveLength(1);
  });

  it.each(['STOP', 'START', 'HELP'])('leaves provider-handled %s controls out of concierge and planner work', async control => {
    db.table('family_contact_channels')[0].ai_concierge_enabled = true;
    const response = await deliver(SMS, { Body: control, OptOutType: control });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message');
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('still rejects a forged opt-out callback before acknowledging it', async () => {
    expect((await deliver(SMS, { Body: 'STOP', OptOutType: 'STOP' }, false)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
