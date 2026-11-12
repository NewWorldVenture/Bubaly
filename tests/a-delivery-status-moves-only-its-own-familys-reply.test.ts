// POST /api/contact-center/sms/status (Register B API-14AB8722BB20), the Twilio
// status callback for a Contact Center auto-reply, driven through the real
// exported handler over the in-memory database seeded with two households'
// reply receipts.
//
// The caller is Twilio, so member roles are n/a (public webhook): the signature
// plus the receipt id and single-use emission token in the signed query are the
// whole boundary. tests/contact-center-sms-status.test.ts already proves, for a
// single household: a non-matching signature header → 403 in every NODE_ENV,
// query/field/origin tampering → 403, malformed identity → 400, mismatched
// receipt/token/from/to/account → 403, replay and out-of-order statuses, a
// corrupted receipt → 503 and a service client that cannot be created → 503.
// Added here: an UNSIGNED request, a signature under another auth token, the
// valid callback read back across BOTH households, household B's receipt
// presented with household A's token (and A's receipt with B's numbers), and a
// failed receipt read answered without its error text.
import { createHash, createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), sendSms: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/guardian/twilio', async original => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(), sendSms: mocks.sendSms, sendSmsWithReceipt: mocks.sendSms,
}));

const ORIGIN = 'https://bubaly.example', PATH = '/api/contact-center/sms/status';
const AUTH = 'test-fake-twilio-token', ACCOUNT = `AC${'c'.repeat(32)}`, NOW = '2026-09-12T12:00:00.000Z';
type Household = { family: string; inbound: string; token: string; revision: string; inSid: string; outSid: string; familyNumber: string; sender: string };
const A: Household = {
  family: 'aaaaaaaa-0000-4000-8000-00000000000a', inbound: 'aaaaaaaa-0000-4000-8000-0000000000a1', token: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  revision: 'aaaaaaaa-0000-4000-8000-0000000000a3', inSid: `SM${'a'.repeat(32)}`, outSid: `SM${'1'.repeat(32)}`, familyNumber: '+15555550100', sender: '+15555550123',
};
const B: Household = {
  family: 'bbbbbbbb-0000-4000-8000-00000000000b', inbound: 'bbbbbbbb-0000-4000-8000-0000000000b1', token: 'bbbbbbbb-0000-4000-8000-0000000000b2',
  revision: 'bbbbbbbb-0000-4000-8000-0000000000b3', inSid: `SM${'b'.repeat(32)}`, outSid: `SM${'2'.repeat(32)}`, familyNumber: '+15555550110', sender: '+15555550133',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let db: ReturnType<typeof createInMemorySupabase>;
const receipts: Record<string, string> = {};

async function seedReply(h: Household) {
  const helper = await import('@/lib/contact-center/sms-reply');
  const receiptId = helper.smsReplyReceiptId(h.family, h.inSid);
  receipts[h.family] = receiptId;
  const binding = { familyId: h.family, channelId: h.family, smsSid: h.inSid, from: h.sender, to: h.familyNumber, body: `Private intake for ${h.family}` };
  const candidate = { summary: 'Synthetic summary', intent: 'other', reply: `Frozen reply for ${h.family}`, locale: 'en-US', suppression: null };
  const outbound = helper.smsReplyOutboundId(receiptId);
  db.seed('family_inbox_messages', [
    { id: h.inbound, family_id: h.family, channel: 'sms', direction: 'inbound', from_addr: binding.from, to_addr: binding.to,
      body: binding.body, subject: null, ai_summary: candidate.summary, ai_intent: candidate.intent, ai_handled: true, status: 'new', provider_ref: h.inSid, occurred_at: NOW },
    { id: outbound, family_id: h.family, channel: 'sms', direction: 'outbound', from_addr: binding.to, to_addr: binding.from,
      body: candidate.reply, subject: null, ai_summary: null, ai_intent: null, ai_handled: true, status: 'read', provider_ref: helper.smsReplyOutboundRef(receiptId), occurred_at: NOW },
  ]);
  db.seed('ai_tool_calls', [{ id: receiptId, family_id: h.family, tool_name: 'contact_center.sms_reply', actor_kind: 'system',
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
    inputs: { version: 1, policyVersion: 1, binding, candidate, fingerprint: hash(JSON.stringify({ binding, candidate })) },
    outputs: { version: 1, revision: h.revision, phase: 'emission_reserved', inboundId: h.inbound, outboundId: outbound,
      emissionToken: h.token, emissionReservedAt: NOW, emissionAccountSid: ACCOUNT, reason: null },
    state: 'reserved', attempt: 1, locked_at: NOW, duration_ms: null, error: null, resource_table: 'family_inbox_messages', resource_id: h.inbound,
    idempotency_key: `contact_center.sms_reply:v1:${hash(JSON.stringify([h.family, 'sms', h.inSid.toLowerCase()]))}`,
    created_at: NOW, updated_at: NOW, finished_at: null,
  }]);
}
/** The status Twilio reports for household h's reply: From is the family number, To the original sender. */
function fields(h: Household, patch: Record<string, string> = {}) {
  return { MessageSid: h.outSid, MessageStatus: 'delivered', From: h.familyNumber, To: h.sender, AccountSid: ACCOUNT, ...patch };
}
function request(receipt: string, token: string, params: Record<string, string>, signature: { token: string } | null = { token: AUTH }) {
  const url = `${ORIGIN}${PATH}?receipt=${receipt}&token=${token}`;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature) headers['x-twilio-signature'] = createHmac('sha1', signature.token)
    .update(url + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64');
  return new NextRequest(url, { method: 'POST', headers, body: new URLSearchParams(params) });
}
async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/contact-center/sms/status/route');
  return POST(req);
}
const receiptOf = (h: Household) => db.table('ai_tool_calls').find(row => row.id === receipts[h.family])!;
const snapshot = () => structuredClone({ calls: db.table('ai_tool_calls'), inbox: db.table('family_inbox_messages') });

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH); vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  db = createInMemorySupabase();
  await seedReply(A); await seedReply(B);
  mocks.admin.mockReturnValue(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('who may call it: only a request Twilio signed (roles n/a, public webhook)', () => {
  it.each([
    ['API-14AB8722BB20 an unsigned status callback for a real receipt and token is refused with 403 and changes nothing', null],
    ['API-14AB8722BB20 a status callback signed with another auth token is refused with 403 and changes nothing', { token: 'test-fake-other-token' }],
  ])('%s', async (_title, signature) => {
    const before = snapshot();
    const response = await post(request(receipts[A.family], A.token, fields(A), signature));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Unauthorized');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe('a correctly signed status end to end', () => {
  it('API-14AB8722BB20 records the delivery on household A’s receipt only, answers an empty TwiML document, and changes neither inbox nor household B', async () => {
    const before = snapshot();
    const beforeB = structuredClone(receiptOf(B));
    const response = await post(request(receipts[A.family], A.token, fields(A)));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect((receiptOf(A).outputs as Record<string, unknown>).delivery).toMatchObject({ providerSid: A.outSid, status: 'delivered' });
    expect(receiptOf(A).family_id).toBe(A.family);
    expect(receiptOf(B)).toEqual(beforeB);
    expect(db.table('family_inbox_messages')).toEqual(before.inbox);
    expect(db.table('ai_tool_calls')).toHaveLength(2);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe('another household’s ids', () => {
  it.each([
    ['API-14AB8722BB20 household B’s receipt presented with household A’s emission token is refused with 403 and neither receipt moves', () => request(receipts[B.family], A.token, fields(B))],
    ['API-14AB8722BB20 household A’s receipt and token reporting household B’s numbers is refused with 403 and neither receipt moves', () => request(receipts[A.family], A.token, fields(A, { From: B.familyNumber, To: B.sender }))],
  ])('%s', async (_title, build) => {
    const before = snapshot();
    const response = await post(build());
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe('Unauthorized');
    expect(snapshot()).toEqual(before);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('API-14AB8722BB20 a failed receipt read answers 503 without its error text and records nothing', async () => {
    mocks.admin.mockReturnValue(withFaults(db, table => (table === 'ai_tool_calls' ? { message: 'test-fake private receipt diagnostic' } : null)));
    const before = snapshot();
    const response = await post(request(receipts[A.family], A.token, fields(A)));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Status temporarily unavailable');
    expect(snapshot()).toEqual(before);
  });
});
