// INT-002: actual callbacks, intake, durable worker and provider adapter.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), admin: vi.fn(), concierge: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
const ORIGIN = 'https://contact.example';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'test-only-contact-token';
const paths = [{ path: '/api/contact-center/sms', status: 200, channel: 'sms' }, { path: `/api/contact-center/voice/transcription?familyId=${FAMILY}`, status: 204, channel: 'voice' }];
let db: ReturnType<typeof createInMemorySupabase>;
const network = vi.fn<typeof fetch>();

async function deliver(path: string) {
  const params: Record<string, string> = { To: '+15555550100', From: '+15555550200', Body: 'Urgent help', MessageSid: 'SM_inbound_repro', RecordingSid: 'RE_inbound_repro', TranscriptionText: 'Urgent help' };
  const url = `${ORIGIN}${path}`;
  const signature = createHmac('sha1', TOKEN).update(url + Object.keys(params).sort().map((key) => key + params[key]).join('')).digest('base64');
  const req = new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(params) });
  expect((await (await import('@/middleware')).middleware(req)).headers.get('x-middleware-next')).toBe('1');
  return path.startsWith('/api/contact-center/sms') ? (await import('@/app/api/contact-center/sms/route')).POST(req) : (await import('@/app/api/contact-center/voice/transcription/route')).POST(req);
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); network.mockReset();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'a'.repeat(32)}`); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN); vi.stubEnv('TWILIO_PHONE_NUMBER', '+15555550999');
  vi.stubGlobal('fetch', network); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.concierge.mockResolvedValue({ intent: 'urgent', summary: 'Urgent help', reply: 'Received', aiUsed: false });
  db = createInMemorySupabase({ uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' }, notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic family', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: '+15555550100', forward_to_phone: '+15555550300', ai_concierge_enabled: false }]);
  mocks.admin.mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.each(paths)('INT-002 $channel urgent recovery', ({ path, status }) => {
  it('durably retries a confirmed 429 after backoff without replaying the accepted send', async () => {
    network.mockResolvedValueOnce(Response.json({ code: 20429, message: 'synthetic rate limit' }, { status: 429 }))
      .mockImplementation(async () => Response.json({ sid: `SM${'1'.repeat(32)}`, status: 'queued' }, { status: 201 }));
    expect((await deliver(path)).status).toBe(status);
    expect((await deliver(path)).status).toBe(status);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('ai_tool_calls')[0].outputs).toMatchObject({ phase: 'queued', notificationDone: true, drain: true });
    const worker = await import('@/lib/contact-center/urgent-delivery');
    expect(await worker.drainUrgentDeliveries(db as never, { now: new Date(Date.now() + 300_000) })).toMatchObject({ accepted: 1, failed: 0 });
    expect((await deliver(path)).status).toBe(status);
    expect(network).toHaveBeenCalledTimes(2);
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', attempt: 2, outputs: { phase: 'accepted', providerSid: `SM${'1'.repeat(32)}`, drain: false } });
    expect(db.table('notifications')).toHaveLength(1);
    expect(String(network.mock.calls[0][0])).toContain('/Messages.json');
  });

  it('recovers both alerts from the pre-capture receipt after process interruption', async () => {
    network.mockImplementation(async () => Response.json({ sid: `SM${'1'.repeat(32)}`, status: 'queued' }, { status: 201 }));
    const server = await import('@/lib/contact-center/server');
    const record = server.recordInboundMessage;
    vi.spyOn(server, 'recordInboundMessage').mockImplementationOnce(async (...args) => {
      await record(...args); // The actual message write committed before interruption.
      throw new Error('simulated process interruption after capture');
    });
    expect((await deliver(path)).status).toBe(503);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
    expect(db.table('ai_tool_calls')[0].outputs).toMatchObject({ phase: 'queued' });
    expect(await (await import('@/lib/contact-center/urgent-delivery')).drainUrgentDeliveries(db as never)).toMatchObject({ accepted: 1 });
    expect((await deliver(path)).status).toBe(status);
    expect(network).toHaveBeenCalledOnce();
    expect(db.table('notifications')).toHaveLength(1);
  });

  it('repairs a returned notification failure independently from an accepted SMS', async () => {
    network.mockImplementation(async () => Response.json({ sid: `SM${'1'.repeat(32)}`, status: 'queued' }, { status: 201 }));
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      if (table === 'notifications') query.then = ((fulfilled, rejected) => Promise.resolve({ data: null, error: { code: '08006', message: 'synthetic write failure', details: null, hint: null }, count: null, status: 503, statusText: 'Service Unavailable' }).then(fulfilled, rejected)) as typeof query.then;
      return query;
    }) as typeof db.from);
    expect((await deliver(path)).status).toBe(503);
    vi.mocked(db.from).mockRestore();
    expect((await deliver(path)).status).toBe(status);
    expect(network).toHaveBeenCalledOnce(); expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'succeeded', outputs: { phase: 'accepted', notificationDone: true, drain: false } });
    expect(console.error).toHaveBeenCalledWith('[contact-center] urgent notification needs recovery');
  });

  it('retains accepted-but-lost uncertainty and never retries by age', async () => {
    let accepted = 0;
    network.mockImplementationOnce(async () => { accepted += 1; throw new DOMException('synthetic lost provider response', 'TimeoutError'); });
    expect((await deliver(path)).status).toBe(status);
    expect((await deliver(path)).status).toBe(status);
    expect(accepted).toBe(1); expect(network).toHaveBeenCalledOnce();
    expect(db.table('ai_tool_calls')[0]).toMatchObject({ state: 'reserved', error: 'contactUrgent.smsUnknown', outputs: { phase: 'unknown', providerSid: null } });
    await (await import('@/lib/contact-center/urgent-delivery')).drainUrgentDeliveries(db as never, { now: new Date(Date.now() + 86_400_000) });
    expect(network).toHaveBeenCalledOnce();
  });
});

describe('Twilio durable-send outcome adapter', () => {
  it.each([
    [201, { sid: `SM${'a'.repeat(32)}`, status: 'queued' }, 'accepted'],
    [201, { sid: `MM${'b'.repeat(32)}`, status: 'accepted' }, 'accepted'],
    [429, { message: 'private rejection' }, 'retryable'],
    [400, { message: 'private rejection' }, 'rejected'],
    [403, { message: 'private rejection' }, 'rejected'],
    [408, {}, 'unknown'], [500, {}, 'unknown'], [302, {}, 'unknown'],
    [200, { sid: `SM${'a'.repeat(32)}`, status: 'queued' }, 'unknown'],
    [201, { sid: 'SM_invalid', status: 'queued' }, 'unknown'],
    [201, { sid: `SM${'a'.repeat(32)}`, status: 'failed' }, 'unknown'],
  ] as const)('classifies status %s / %j as %s without disclosing provider errors', async (status, body, kind) => {
    network.mockResolvedValueOnce(Response.json(body, { status }));
    const result = await (await import('@/lib/guardian/twilio')).sendSmsWithReceipt('+15555550300', 'Urgent help');
    expect(result.kind).toBe(kind);
    expect(JSON.stringify(result)).not.toContain('private rejection');
    expect(network).toHaveBeenCalledOnce();
    const [url, init] = network.mock.calls[0];
    expect(new URL(String(url)).origin).toBe('https://api.twilio.com');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('keeps malformed and oversized successful responses unknown', async () => {
    network.mockResolvedValueOnce(new Response('{malformed', { status: 201 }))
      .mockResolvedValueOnce(new Response(`{"value":"${'x'.repeat(66_000)}"}`, { status: 201 }));
    const adapter = (await import('@/lib/guardian/twilio')).sendSmsWithReceipt;
    expect(await adapter('+15555550300', 'Urgent help')).toEqual({ kind: 'unknown' });
    expect(await adapter('+15555550300', 'Urgent help')).toEqual({ kind: 'unknown' });
  });
  it('never sends invalid messages or treats missing configuration as acceptance', async () => {
    const adapter = (await import('@/lib/guardian/twilio')).sendSmsWithReceipt;
    expect(await adapter('bad-phone', 'Urgent help')).toEqual({ kind: 'rejected', code: 'invalid_message' });
    expect(await adapter('+15555550300', 'x'.repeat(1601))).toEqual({ kind: 'rejected', code: 'invalid_message' });
    vi.stubEnv('TWILIO_AUTH_TOKEN', ''); vi.resetModules();
    expect(await (await import('@/lib/guardian/twilio')).sendSmsWithReceipt('+15555550300', 'Urgent help')).toEqual({ kind: 'unconfigured' });
    expect(network).not.toHaveBeenCalled();
  });
  it('bounds a hanging provider with the supplied deadline and keeps acceptance unknown', async () => {
    network.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Synthetic timeout', 'AbortError')), { once: true });
    }));
    const result = await (await import('@/lib/guardian/twilio')).sendSmsWithReceipt('+15555550300', 'Urgent help', AbortSignal.timeout(5));
    expect(result).toEqual({ kind: 'unknown' }); expect(network).toHaveBeenCalledOnce();
  });
});
