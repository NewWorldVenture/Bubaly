// POST /api/contact-center/sms (Register B API-387E2B30BCD7), driven through the
// real exported handler over the in-memory database seeded with two households.
//
// The caller is Twilio, so member roles are n/a (public webhook, middleware
// PUBLIC allowlist): the X-Twilio-Signature is the entire authorization
// boundary. What existing tests already prove is not repeated here:
//  - tests/contact-center-callback-boundary.test.ts: invalid signature → 401
//    through middleware; dedupe against a foreign-family inbox row → 503.
//  - tests/contact-center-sms-ingress-route.test.ts: signed-original capture,
//    family reassignment, unknown-number ack, opt-out controls.
//  - tests/an-inbound-text-or-voicemail-is-budgeted.test.ts: concierge/reply budgets.
// Added here: an UNSIGNED request, a signature under a different token, a
// signature whose To was changed from household B's number to A's, the full
// valid text with both households read back, a SID owned by household B, and a
// failed routing read answered without its error text.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), concierge: vi.fn(), sendSms: vi.fn(), submit: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: mocks.submit }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('@/lib/guardian/twilio', async original => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: mocks.sendSms,
  sendSmsWithReceipt: mocks.sendSms,
}));

const ORIGIN = 'https://bubaly.example';
const PATH = '/api/contact-center/sms';
const TOKEN = 'test-fake-twilio-token';
const A = { family: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Household Alpha', number: '+15555550100' };
const B = { family: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Household Bravo', number: '+15555550110' };
const NEIGHBOUR = '+15555550123';
const SID = `SM${'1'.repeat(32)}`;
const B_SID = `SM${'b'.repeat(32)}`;
const B_INBOX = 'bbbbbbbb-0000-4000-8000-0000000000b1';
let db: ReturnType<typeof createInMemorySupabase>;

function form(fields: Record<string, string> = {}) {
  return { To: A.number, From: NEIGHBOUR, Body: 'Can we book a dentist visit Friday?', MessageSid: SID, ...fields };
}
function sign(params: Record<string, string>, token = TOKEN) {
  const payload = `${ORIGIN}${PATH}` + Object.keys(params).sort().map(key => key + params[key]).join('');
  return createHmac('sha1', token).update(payload).digest('base64');
}
function request(params: Record<string, string>, signature: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return new NextRequest(`${ORIGIN}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(params) });
}
async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/contact-center/sms/route');
  return POST(req);
}
const householdRows = (family: string) => ['family_inbox_messages', 'ai_tool_calls', 'notifications', 'family_contact_channels']
  .flatMap(table => db.table(table).filter(row => row.family_id === family).map(row => ({ table, row: structuredClone(row) })));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('TWILIO_ACCOUNT_SID', '');
  vi.stubEnv('INTERNAL_SECRET', 'test-fake-internal-secret');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = createInMemorySupabase({
    uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new', occurred_at: '2026-09-12T00:00:00.000Z' } },
    rpc: { rate_limit_hit: rateLimitHit },
  });
  db.seed('families', [{ id: A.family, name: A.name, timezone: 'UTC' }, { id: B.family, name: B.name, timezone: 'UTC' }]);
  db.seed('family_contact_channels', [
    { id: 'channel-a', family_id: A.family, phone_number: A.number, email_local: 'alpha', ai_concierge_enabled: true, forward_to_phone: null },
    { id: 'channel-b', family_id: B.family, phone_number: B.number, email_local: 'bravo', ai_concierge_enabled: true, forward_to_phone: '+15555550199' },
  ]);
  db.seed('family_inbox_messages', [{ id: B_INBOX, family_id: B.family, channel: 'sms', direction: 'inbound', from_addr: NEIGHBOUR,
    to_addr: B.number, body: 'Bravo private note', subject: null, ai_summary: 'Bravo summary', ai_intent: 'other', ai_handled: true,
    status: 'new', provider_ref: B_SID, occurred_at: '2026-09-11T00:00:00.000Z' }]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'appointment', summary: 'Dentist visit request', reply: 'Thanks, we will confirm Friday.', aiUsed: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('who may call it: only a request Twilio signed (roles n/a, public webhook)', () => {
  it.each([
    ['API-387E2B30BCD7 an unsigned request is refused with 401 and writes nothing', () => request(form(), null)],
    ['API-387E2B30BCD7 a signature made with another auth token is refused with 401 and writes nothing', () => request(form(), sign(form(), 'test-fake-other-token'))],
    ['API-387E2B30BCD7 a text signed for household B whose To was changed to household A is refused with 401', () => request(form(), sign(form({ To: B.number })))],
  ])('%s', async (_title, build) => {
    const beforeA = householdRows(A.family), beforeB = householdRows(B.family);
    const response = await post(build());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(householdRows(A.family)).toEqual(beforeA);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(db.table('rate_limits')).toHaveLength(0);
  });
});

describe('a correctly signed text end to end', () => {
  it('API-387E2B30BCD7 files the text for the household that owns To, answers one TwiML reply with its status callback, and leaves household B untouched', async () => {
    const beforeB = householdRows(B.family);
    const response = await post(request(form(), sign(form())));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml');
    const xml = await response.text();

    const inbound = db.table('family_inbox_messages').filter(row => row.family_id === A.family && row.direction === 'inbound');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ channel: 'sms', from_addr: NEIGHBOUR, to_addr: A.number, body: 'Can we book a dentist visit Friday?',
      provider_ref: SID, ai_summary: 'Dentist visit request', ai_intent: 'appointment' });
    const outbound = db.table('family_inbox_messages').filter(row => row.family_id === A.family && row.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ channel: 'sms', to_addr: NEIGHBOUR, body: 'Thanks, we will confirm Friday.' });

    const reply = db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.sms_reply');
    expect(reply).toHaveLength(1);
    expect(reply[0].family_id).toBe(A.family);
    const outputs = reply[0].outputs as { emissionToken: string };
    const ingress = db.table('ai_tool_calls').filter(row => row.tool_name === 'contact_center.sms_ingress');
    expect(ingress.map(row => row.family_id)).toEqual([A.family]);

    const callback = `${ORIGIN}/api/contact-center/sms/status?receipt=${reply[0].id}&amp;token=${outputs.emissionToken}`;
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Message action="${callback}" statusCallback="${callback}" method="POST">Thanks, we will confirm Friday.</Message></Response>`);
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(mocks.concierge.mock.calls[0][0]).toMatchObject({ channel: 'sms', from: NEIGHBOUR, familyLabel: A.name });
    expect(xml).not.toContain(B.name);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe('another household’s ids', () => {
  it('API-387E2B30BCD7 a signed text to household A carrying a MessageSid household B already filed answers 503, files nothing for A and leaves B’s row as it was', async () => {
    const beforeB = householdRows(B.family);
    const response = await post(request(form({ MessageSid: B_SID }), sign(form({ MessageSid: B_SID }))));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('Inbox temporarily unavailable');
    expect(body).not.toContain('Bravo');
    expect(body).not.toContain(B.family);
    expect(db.table('family_inbox_messages').filter(row => row.family_id === A.family)).toHaveLength(0);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe('another household’s signed original', () => {
  it('API-387E2B30BCD7 a MessageSid first delivered to household B and replayed to household A’s number answers 503 and grants A no intake, reply or planner run', async () => {
    const SHARED = `SM${'5'.repeat(32)}`;
    expect((await post(request(form({ To: B.number, MessageSid: SHARED }), sign(form({ To: B.number, MessageSid: SHARED }))))).status).toBe(200);
    const beforeB = householdRows(B.family);
    mocks.concierge.mockClear();
    const response = await post(request(form({ MessageSid: SHARED }), sign(form({ MessageSid: SHARED }))));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Intake temporarily unavailable');
    expect(householdRows(A.family).filter(entry => entry.table !== 'family_contact_channels')).toEqual([]);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('API-387E2B30BCD7 a failed number-routing read answers 503 without its error text and files nothing', async () => {
    mocks.admin.mockReturnValue(withFaults(db, (table, calls) => (
      table === 'family_contact_channels' && calls.some(call => call.method === 'eq' && call.args[0] === 'phone_number')
        ? { message: 'test-fake private routing diagnostic' } : null)));
    const response = await post(request(form(), sign(form())));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('Routing temporarily unavailable');
    expect(db.table('family_inbox_messages').filter(row => row.family_id === A.family)).toHaveLength(0);
    expect(mocks.concierge).not.toHaveBeenCalled();
  });
});
