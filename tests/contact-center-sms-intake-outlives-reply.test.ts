// An inbound text is filed even when the concierge reply cannot be prepared.
//
// Twilio does not retry an inbound-SMS webhook. The route answered 503 whenever
// `prepareSmsReply` rejected — a concierge that overran its 15s candidate
// budget, an aborted signal, one slow read in the reply bookkeeping — and
// nothing had been written yet: no inbox row, no urgent escalation, no planner
// handoff. The family simply never saw the message. Filing it is the part that
// must not depend on being able to answer it.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), admin: vi.fn(), concierge: vi.fn(), planner: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
// Only the planner handoff is stubbed — its own intake has its own tests, and
// what matters here is that it is reached at all, carrying the fallback intent.
vi.mock('@/lib/contact-center/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contact-center/server')>()),
  routeInboundToPlanner: mocks.planner,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));

const ORIGIN = 'https://contact.example';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'test-only-contact-token';
let db: ReturnType<typeof createInMemorySupabase>;
const network = vi.fn<typeof fetch>();

async function deliver(body: string) {
  const params: Record<string, string> = { To: '+15555550100', From: '+15555550200', Body: body, MessageSid: `SM${'b'.repeat(32)}` };
  const url = `${ORIGIN}/api/contact-center/sms`;
  const signature = createHmac('sha1', TOKEN).update(url + Object.keys(params).sort().map((key) => key + params[key]).join('')).digest('base64');
  const req = new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(params) });
  return (await import('@/app/api/contact-center/sms/route')).POST(req);
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); network.mockReset();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.co'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  vi.stubEnv('TWILIO_ACCOUNT_SID', `AC${'a'.repeat(32)}`); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN); vi.stubEnv('TWILIO_PHONE_NUMBER', '+15555550999');
  vi.stubGlobal('fetch', network); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  network.mockResolvedValue(Response.json({ sid: `SM${'1'.repeat(32)}`, status: 'queued' }, { status: 201 }));
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.planner.mockResolvedValue({ routed: true, requestId: 'synthetic-request', runId: null, paperworkItemId: null, reason: 'routed' });
  db = createInMemorySupabase({ uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new' }, notifications: { is_read: false, sent_at: null, pushed_at: null } } });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic family', timezone: 'UTC' }]);
  db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: '+15555550100', forward_to_phone: '+15555550300', ai_concierge_enabled: false }]);
  mocks.admin.mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('inbound SMS intake outlives a failed reply preparation', () => {
  it('files an urgent text and escalates it when the candidate cannot be produced', async () => {
    // The factory rejecting is what a blown 15s budget looks like from the
    // route's side; the reason it rejected does not change the obligation.
    mocks.concierge.mockRejectedValue(new DOMException('deadline', 'TimeoutError'));

    const response = await deliver('Urgent help, the kitchen is flooding');
    expect(response.status).toBe(200);
    // No reply went out: the concierge could not write one and the route must
    // not invent one. An empty TwiML body is the honest answer.
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const filed = db.table('family_inbox_messages');
    expect(filed, 'the text is filed even with no reply').toHaveLength(1);
    expect(filed[0]).toMatchObject({ family_id: FAMILY, channel: 'sms', ai_intent: 'urgent' });
    expect(String(filed[0].ai_summary)).toContain('flooding');
    // The whole point: the deterministic classifier still calls it urgent, so
    // the human fallback number is still told about it.
    expect(network.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('Messages'))).not.toHaveLength(0);
  });

  it('classifies a non-urgent text without escalating it', async () => {
    mocks.concierge.mockRejectedValue(new Error('synthetic concierge outage'));
    expect((await deliver('Your package was left at the back door')).status).toBe(200);
    expect(db.table('family_inbox_messages')[0]).toMatchObject({ ai_intent: 'delivery' });
    // The degraded intent is what the planner is handed, not a blank 'other'.
    expect(mocks.planner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ intent: 'delivery' }));
    expect(network.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('Messages'))).toHaveLength(0);
  });

  it('replays to the same inbox row rather than filing the text twice', async () => {
    mocks.concierge.mockRejectedValue(new Error('synthetic concierge outage'));
    expect((await deliver('Urgent help')).status).toBe(200);
    expect((await deliver('Urgent help')).status).toBe(200);
    expect(db.table('family_inbox_messages')).toHaveLength(1);
  });

  it('uses the concierge verdict, not the fallback, when it does answer', async () => {
    // The body reads as `personal` to the deterministic classifier, so filing
    // it as `delivery` can only mean the concierge's answer was used — the
    // control that the fallback above did not quietly become the normal path.
    mocks.concierge.mockResolvedValue({ intent: 'delivery', summary: 'A parcel note', reply: 'Got it', aiUsed: true });
    // The status is deliberately not asserted: emitting the reply needs the
    // conditional `ai_tool_calls` transitions that only the PostgREST-shaped
    // fixture in contact-center-sms-reply.test.ts models. What is asserted here
    // is everything that happens before that, which is where the fallback lives.
    await deliver('Just letting you know');
    expect(db.table('family_inbox_messages')[0]).toMatchObject({ ai_intent: 'delivery', ai_summary: 'A parcel note' });
    expect(mocks.planner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ intent: 'delivery' }));
  });
});
