// A Guardian call is answered only under the household whose number it rang,
// and only when Twilio signed it (Register B API-262DB8655008).
//
// The route is on the middleware public allowlist; the Twilio signature is its
// whole authorization boundary (lib/server/twilio-ingress.ts). These drive the
// real handler, the real signature check and the real decision pipeline over an
// in-memory database seeded with two households, and read the tables back.
// Nothing is mocked but translation and the database seam; `fetch` refuses
// every call, which also proves caller-ID lookup reached no provider (it is a
// no-op without TWILIO_ACCOUNT_SID).
//
// Already proven elsewhere and not repeated: a profile naming another family's
// member (a-guardian-number-rings-only-its-own-family, a-guardian-number-only-
// reaches-its-own-familys-member), the claim on replay, a stale claim, a failed
// number lookup and a failed pipeline giving the claim back (a-callback-that-
// asked-for-a-retry-can-be-retried), body bounds (raw-body-boundaries), and a
// deployment with no TWILIO_AUTH_TOKEN refusing 503 (twilio-ingress-verifies-
// everywhere).
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, cookieClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db, createServer: seam.cookieClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-voice.example.com';
const PATH = '/api/guardian/inbound/voice';
const TOKEN = 'fake-twilio-auth-token-for-tests';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const CHILD_A = 'a0000000-0000-4000-8000-0000000000c1';
const CHILD_B = 'b0000000-0000-4000-8000-0000000000c1';
const NUMBER_A = '+15555550101';
const NUMBER_B = '+15555550102';
const CHILD_A_PHONE = '+15555550111';
const CHILD_B_PHONE = '+15555550112';
const CALLER = '+15555550150';
const CALL_SID = `CA${'1'.repeat(32)}`;

let db: InMemorySupabase;

function form(overrides: Record<string, string> = {}): Record<string, string> {
  return { CallSid: CALL_SID, From: CALLER, To: NUMBER_B, CallStatus: 'ringing', ...overrides };
}

function signature(fields: Record<string, string>, token = TOKEN): string {
  const sorted = Object.keys(fields).sort().map((key) => `${key}${fields[key]}`).join('');
  return createHmac('sha1', token).update(`${ORIGIN}${PATH}${sorted}`).digest('base64');
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const signedPost = (fields = form()) => post(fields, { 'x-twilio-signature': signature(fields) });

async function deliver(request: NextRequest): Promise<Response> {
  const { POST } = await import('@/app/api/guardian/inbound/voice/route');
  return POST(request);
}

const rowsOf = (table: string, familyId: string) => db.table(table).filter((row) => row.family_id === familyId);

function seed(): InMemorySupabase {
  const store = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  store.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  store.seed('family_members', [
    { id: CHILD_A, family_id: FAMILY_A, display_name: 'Child A', role: 'child', phone: CHILD_A_PHONE, is_active: true },
    { id: CHILD_B, family_id: FAMILY_B, display_name: 'Child B', role: 'child', phone: CHILD_B_PHONE, is_active: true },
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
  // The caller is household A's immediate family. To household B they are a stranger.
  store.seed('guardian_contacts', [
    { id: 'a0000000-0000-4000-8000-0000000000e1', family_id: FAMILY_A, phone: CALLER, name: 'Relative of A', trust_level: 'immediate_family', spam_score: 0 },
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
  seam.cookieClient.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function expectNothingReached() {
  expect(db.log).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(seam.cookieClient).not.toHaveBeenCalled();
}

describe('POST /api/guardian/inbound/voice: who may call it', () => {
  it('API-262DB8655008 an unsigned request is refused 401 and reaches no table and no provider, even with a member session cookie', async () => {
    const response = await deliver(post(form(), { cookie: 'sb-access-token=fake-session-of-parent-b' }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });

  it('API-262DB8655008 a request signed with the wrong token is refused 401 and writes nothing', async () => {
    const fields = form();
    const response = await deliver(post(fields, { 'x-twilio-signature': signature(fields, 'fake-wrong-token') }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expectNothingReached();
  });

  it('API-262DB8655008 a valid signature cannot be moved onto another household\'s number', async () => {
    const response = await deliver(post(form({ To: NUMBER_A }), { 'x-twilio-signature': signature(form()) }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });
});

describe('POST /api/guardian/inbound/voice: a signed call end to end', () => {
  it('API-262DB8655008 a stranger to household B is sent to B\'s voicemail, recorded under B, and the callback is closed', async () => {
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/xml');
    const xml = await response.text();

    const comms = rowsOf('guardian_communications', FAMILY_B);
    expect(comms).toHaveLength(1);
    expect(comms[0]).toMatchObject({
      member_id: CHILD_B, comm_type: 'call_inbound', direction: 'inbound', from_number: CALLER, to_number: NUMBER_B,
      twilio_call_sid: CALL_SID, trust_level_at_time: 'unknown', routing_mode_used: 'voicemail_first', status: 'handled', contact_id: null,
    });
    // The voicemail callback is bound to B's communication and greets with B's member.
    expect(xml).toContain('<Record');
    expect(xml).toContain(`${ORIGIN}/api/guardian/status/voicemail?commId=${comms[0].id}`);
    expect(xml).toContain('Child B');
    expect(xml).not.toContain('<Dial');
    expect(db.table('guardian_callback_events')).toEqual([
      expect.objectContaining({ event_id: CALL_SID, callback_type: 'inbound_voice', status: 'processed' }),
    ]);
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('API-262DB8655008 household A\'s trust in the caller does not travel: B\'s number never dials, and A\'s number does (control)', async () => {
    const toB = await (await deliver(signedPost())).text();
    expect(toB).not.toContain(CHILD_A_PHONE);
    expect(toB).not.toContain(CHILD_B_PHONE);

    const fields = form({ To: NUMBER_A, CallSid: `CA${'2'.repeat(32)}` });
    const toA = await (await deliver(post(fields, { 'x-twilio-signature': signature(fields) }))).text();
    expect(toA).toContain('<Dial');
    expect(toA).toContain(CHILD_A_PHONE);
    expect(toA).not.toContain(CHILD_B_PHONE);
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([
      expect.objectContaining({ member_id: CHILD_A, trust_level_at_time: 'immediate_family', routing_mode_used: 'immediate_ring', status: 'handled' }),
    ]);
    expect(rowsOf('guardian_communications', FAMILY_B)).toHaveLength(1);
  });

  it('API-262DB8655008 a replayed signed call is hung up on without a second record', async () => {
    expect((await deliver(signedPost())).status).toBe(200);
    const replay = await deliver(signedPost());
    expect(replay.status).toBe(200);
    const xml = await replay.text();
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Record');
    expect(db.table('guardian_communications')).toHaveLength(1);
  });
});

describe('POST /api/guardian/inbound/voice: failure', () => {
  it('API-262DB8655008 a screening session that cannot be opened answers 503 so Twilio falls back, never a gather into nothing', async () => {
    db.seed('guardian_contacts', [
      { id: 'b0000000-0000-4000-8000-0000000000e1', family_id: FAMILY_B, phone: CALLER, name: 'Acquaintance of B', trust_level: 'known_contact', spam_score: 0 },
    ]);
    const healthy = db;
    seam.db = withFaults(db, (table) => (table === 'guardian_screening_sessions'
      ? { code: '42501', message: 'private database detail must never leave the server' } : null));
    const response = await deliver(signedPost());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('');
    expect(healthy.table('guardian_screening_sessions')).toEqual([]);
    // The routing decision is on record under B, as the route documents; no gather was answered.
    expect(rowsOf('guardian_communications', FAMILY_B)).toEqual([expect.objectContaining({ routing_mode_used: 'ai_handle_first' })]);
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([]);
  });
});
