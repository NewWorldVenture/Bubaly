// A WhatsApp message lands only in the household whose Guardian number it
// reached, and only when Twilio signed it (Register B API-90346B8397DA).
//
// The route is on the middleware public allowlist: its caller is Twilio, so the
// request signature is the whole authorization boundary
// (lib/server/twilio-ingress.ts). These drive the real handler, the real
// signature check, the real decision pipeline and the real notification
// service over an in-memory database seeded with two households, and read the
// tables back. Only the providers are stubbed: the scam model
// (lib/guardian/scam-ai) and Twilio's outbound SMS/call, at the seams the
// neighbouring Guardian tests stub them; `fetch` refuses every call.
//
// Already proven elsewhere and not repeated here: emergency escalation and its
// redelivery (an-emergency-text-reaches-a-manager, a-retried-webhook-does-not-
// alarm-twice), the model cap (an-inbound-text-does-not-buy-a-model-call), a
// profile naming another family's member (a-guardian-number-only-reaches-its-
// own-familys-member), a failed number lookup releasing the claim
// (a-guardian-number-lookup-failure-is-not-an-unknown-number), body bounds
// (raw-body-boundaries, guardian-callback-security), and a deployment with no
// TWILIO_AUTH_TOKEN refusing 503 (twilio-ingress-verifies-everywhere: the token
// is captured at module load, behind this file's Twilio seam).
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, scam: vi.fn(), sms: [] as string[], calls: [] as string[], cookieClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db, createServer: seam.cookieClient }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: async (to: string) => { seam.sms.push(to); },
  initiateCall: async ({ to }: { to: string }) => { seam.calls.push(to); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-whatsapp.example.com';
const PATH = '/api/guardian/inbound/whatsapp';
const TOKEN = 'fake-twilio-auth-token-for-tests';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const CHILD_A = 'a0000000-0000-4000-8000-0000000000c1';
const PARENT_A = 'a0000000-0000-4000-8000-0000000000d1';
const CHILD_B = 'b0000000-0000-4000-8000-0000000000c1';
const PARENT_B = 'b0000000-0000-4000-8000-0000000000d1';
const NUMBER_A = '+15555550101';
const NUMBER_B = '+15555550102';
const SENDER = '+15555550150';
const SID = `SM${'1'.repeat(32)}`;
const BODY = 'running ten minutes late for pickup';

let db: InMemorySupabase;

function form(overrides: Record<string, string> = {}): Record<string, string> {
  return { SmsSid: SID, From: `whatsapp:${SENDER}`, To: `whatsapp:${NUMBER_B}`, Body: BODY, ...overrides };
}

function signature(fields: Record<string, string>, token = TOKEN, url = `${ORIGIN}${PATH}`): string {
  const sorted = Object.keys(fields).sort().map((key) => `${key}${fields[key]}`).join('');
  return createHmac('sha1', token).update(url + sorted).digest('base64');
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function deliver(request: NextRequest): Promise<Response> {
  const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
  return POST(request);
}

const signedPost = (fields = form()) => post(fields, { 'x-twilio-signature': signature(fields) });
const rowsOf = (table: string, familyId: string) => db.table(table).filter((row) => row.family_id === familyId);

function seed(): InMemorySupabase {
  const store = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], guardian_communications: [['twilio_sms_sid']], notifications: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  store.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  store.seed('family_members', [
    { id: PARENT_A, family_id: FAMILY_A, user_id: 'user-parent-a', display_name: 'Parent A', role: 'parent', is_active: true },
    { id: CHILD_A, family_id: FAMILY_A, user_id: 'user-child-a', display_name: 'Child A', role: 'child', is_active: true },
    { id: PARENT_B, family_id: FAMILY_B, user_id: 'user-parent-b', display_name: 'Parent B', role: 'parent', is_active: true },
    { id: CHILD_B, family_id: FAMILY_B, user_id: 'user-child-b', display_name: 'Child B', role: 'child', is_active: true },
  ]);
  const profile = {
    is_active: true, ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
  };
  store.seed('guardian_member_profiles', [
    { ...profile, id: 'a0000000-0000-4000-8000-0000000000f1', family_id: FAMILY_A, member_id: CHILD_A, guardian_phone: NUMBER_A },
    { ...profile, id: 'b0000000-0000-4000-8000-0000000000f1', family_id: FAMILY_B, member_id: CHILD_B, guardian_phone: NUMBER_B },
  ]);
  return store;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this test'); }));
  db = seed();
  seam.db = db;
  seam.sms.length = 0;
  seam.calls.length = 0;
  seam.scam.mockReset().mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.cookieClient.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function expectNothingReached() {
  expect(db.log).toEqual([]);
  expect(seam.scam).not.toHaveBeenCalled();
  expect(seam.sms).toEqual([]);
  expect(seam.calls).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
}

describe('POST /api/guardian/inbound/whatsapp: who may call it', () => {
  it('API-90346B8397DA an unsigned request is refused 401 and reaches no table and no provider, even with a member session cookie', async () => {
    const response = await deliver(post(form(), { cookie: 'sb-access-token=fake-session-of-parent-a' }));
    expect(response.status).toBe(401);
    expectNothingReached();
    // A household member's session is not a credential here: the route never asks for one.
    expect(seam.cookieClient).not.toHaveBeenCalled();
  });

  it('API-90346B8397DA a request signed with the wrong token is refused 401 and writes nothing', async () => {
    const fields = form();
    const response = await deliver(post(fields, { 'x-twilio-signature': signature(fields, 'fake-wrong-token') }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expectNothingReached();
  });

  it('API-90346B8397DA a signature over different fields is refused: the body cannot be swapped under a valid signature', async () => {
    const response = await deliver(post(form({ To: `whatsapp:${NUMBER_A}` }), { 'x-twilio-signature': signature(form()) }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });
});

describe('POST /api/guardian/inbound/whatsapp: a signed message end to end', () => {
  it('API-90346B8397DA records the message under the household whose number it reached, tells only that household, and closes the callback', async () => {
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');

    const comms = rowsOf('guardian_communications', FAMILY_B);
    expect(comms).toHaveLength(1);
    expect(comms[0]).toMatchObject({
      member_id: CHILD_B, comm_type: 'whatsapp_inbound', direction: 'inbound',
      from_number: SENDER, to_number: NUMBER_B, body: BODY, twilio_sms_sid: SID, status: 'received', scam_detected: false,
    });
    expect(db.table('guardian_callback_events')).toEqual([
      expect.objectContaining({ event_id: SID, callback_type: 'inbound_whatsapp', status: 'processed' }),
    ]);

    const notices = db.table('notifications');
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice).toMatchObject({ family_id: FAMILY_B, related_type: 'guardian_communications', related_id: comms[0].id });
      expect(String(notice.title)).toContain('WhatsApp from');
    }
    // 'family' fans out to one row per member account of household B, and no other.
    expect(notices.map((notice) => notice.user_id).sort()).toEqual(['user-child-b', 'user-parent-b']);
    expect(seam.scam).toHaveBeenCalledTimes(1);

    // Household A is untouched.
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([]);
    expect(rowsOf('notifications', FAMILY_A)).toEqual([]);
    expect(seam.sms).toEqual([]);
    expect(seam.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('API-90346B8397DA a replayed delivery of the same signed message is acknowledged without a second record, notice or model call', async () => {
    expect((await deliver(signedPost())).status).toBe(200);
    const commsAfterFirst = db.table('guardian_communications').length;
    const noticesAfterFirst = db.table('notifications').length;
    const lookupsAfterFirst = db.log.filter((entry) => entry.table === 'guardian_member_profiles').length;
    expect(commsAfterFirst).toBe(1);

    const replay = await deliver(signedPost());
    expect(replay.status).toBe(200);
    expect(db.table('guardian_communications')).toHaveLength(commsAfterFirst);
    expect(db.table('notifications')).toHaveLength(noticesAfterFirst);
    expect(seam.scam).toHaveBeenCalledTimes(1);
    // The claim answers the replay before any routing: the number is not even looked up again.
    expect(db.log.filter((entry) => entry.table === 'guardian_member_profiles')).toHaveLength(lookupsAfterFirst);
  });

  it('API-90346B8397DA a message to household A\'s number lands in A and leaves household B untouched (the mirror case)', async () => {
    const fields = form({ To: `whatsapp:${NUMBER_A}`, SmsSid: `SM${'2'.repeat(32)}` });
    expect((await deliver(post(fields, { 'x-twilio-signature': signature(fields) }))).status).toBe(200);
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([expect.objectContaining({ member_id: CHILD_A, to_number: NUMBER_A })]);
    expect(rowsOf('guardian_communications', FAMILY_B)).toEqual([]);
    expect(rowsOf('notifications', FAMILY_B)).toEqual([]);
  });
});

describe('POST /api/guardian/inbound/whatsapp: failure', () => {
  // A failed member read giving the claim back is proven in
  // a-guardian-number-only-reaches-its-own-familys-member; this is the write
  // the route documents as degrading loudly instead (Audit C1-S9-39).
  it('API-90346B8397DA a refused communication insert still delivers the message to household B, buys no model call, and says nothing internal', async () => {
    const healthy = db;
    seam.db = withFaults(db, (table, calls) => (table === 'guardian_communications' && calls.some((call) => call.method === 'insert')
      ? { code: '42501', message: 'private database detail must never leave the server' } : null));
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(healthy.table('guardian_communications')).toEqual([]);
    // An uncounted message cannot be checked against the cap, so the model is not asked.
    expect(seam.scam).not.toHaveBeenCalled();
    const notices = healthy.table('notifications');
    expect(notices.map((notice) => notice.user_id).sort()).toEqual(['user-child-b', 'user-parent-b']);
    for (const notice of notices) expect(notice).toMatchObject({ family_id: FAMILY_B, related_id: null });
    expect(healthy.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: SID, status: 'processed' })]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not record the communication'), expect.anything());
  });
});
