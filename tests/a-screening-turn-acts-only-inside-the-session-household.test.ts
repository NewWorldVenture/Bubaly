// A screening turn acts only inside the household its session belongs to, and
// only when Twilio signed it (Register B API-5A16104BF051).
//
// The route is on the middleware public allowlist; the Twilio signature, over
// the full URL including `?sessionId=&turn=`, is its whole authorization
// boundary (lib/server/twilio-ingress.ts). These drive the real handler, the
// real signature check and the real screening model client over an in-memory
// database seeded with two households, and read the tables back. The model
// provider is reached through `fetch`, stubbed here to answer as OpenAI's chat
// endpoint would (or to fail), so no network is reached.
//
// Already proven elsewhere and not repeated: the claim on replay, a stale
// claim, and a failed session, communication or profile read giving the claim
// back (a-screening-turn-or-escalation-that-asked-for-a-retry-can-be-retried),
// the called member's profile in a family protecting two (a-screened-call-
// reaches-the-member-it-was-for), a profile naming another family's member
// (a-guardian-number-rings-only-its-own-family), an emergency decision
// escalating (an-emergency-text-reaches-a-manager), turn bounds
// (guardian-callback-security), and a deployment with no TWILIO_AUTH_TOKEN
// refusing 503 (twilio-ingress-verifies-everywhere).
//
// guardian_screening_sessions has a family-member SELECT policy only
// (01370_ai_call_guardian.sql), so sessions are written by the service role
// alone, by the voice route; a session id is not something a household can mint.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, cookieClient: vi.fn(), sms: [] as string[], calls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db, createServer: seam.cookieClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  sendSms: async (to: string) => { seam.sms.push(to); },
  initiateCall: async ({ to }: { to: string }) => { seam.calls.push(to); },
}));

const ORIGIN = 'https://guardian-screen.example.com';
const TOKEN = 'fake-twilio-auth-token-for-tests';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const CHILD_A = 'a0000000-0000-4000-8000-0000000000c1';
const CHILD_B = 'b0000000-0000-4000-8000-0000000000c1';
const COMM_A = 'a0000000-0000-4000-8000-0000000000a1';
const COMM_B = 'b0000000-0000-4000-8000-0000000000a1';
const SESSION_A = 'a0000000-0000-4000-8000-0000000000b1';
const SESSION_B = 'b0000000-0000-4000-8000-0000000000b1';
const CHILD_A_PHONE = '+15555550111';
const CHILD_B_PHONE = '+15555550112';
const CALLER = '+15555550150';
const CALL_SID = `CA${'1'.repeat(32)}`;
const SPEECH = 'Hi, this is a relative calling to check in.';
const DECISION = '{"action":"transfer","risk":"safe","urgency":"medium","intent":"personal","summary":"A relative is checking in.","callerName":"Relative"}';

let db: InMemorySupabase;
let modelAnswer: () => Promise<Response>;

const path = (sessionId = SESSION_B, turn = 1) => `/api/guardian/screen?sessionId=${sessionId}&turn=${turn}`;
const form = (overrides: Record<string, string> = {}) => ({ CallSid: CALL_SID, SpeechResult: SPEECH, ...overrides });

function signature(fields: Record<string, string>, signedPath: string, token = TOKEN): string {
  const sorted = Object.keys(fields).sort().map((key) => `${key}${fields[key]}`).join('');
  return createHmac('sha1', token).update(`${ORIGIN}${signedPath}${sorted}`).digest('base64');
}

function post(requestPath: string, fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${requestPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const signedPost = (requestPath = path(), fields = form()) => post(requestPath, fields, { 'x-twilio-signature': signature(fields, requestPath) });

async function deliver(request: NextRequest): Promise<Response> {
  const { POST } = await import('@/app/api/guardian/screen/route');
  return POST(request);
}

const rowsOf = (table: string, familyId: string) => db.table(table).filter((row) => row.family_id === familyId);
const modelCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('https://api.openai.com/'));

function seed(): InMemorySupabase {
  const store = createInMemorySupabase({ uniques: { guardian_callback_events: [['event_id']] } });
  store.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  store.seed('family_members', [
    { id: CHILD_A, family_id: FAMILY_A, display_name: 'Child A', role: 'child', phone: CHILD_A_PHONE, is_active: true },
    { id: CHILD_B, family_id: FAMILY_B, display_name: 'Child B', role: 'child', phone: CHILD_B_PHONE, is_active: true },
  ]);
  store.seed('guardian_member_profiles', [
    { id: 'a0000000-0000-4000-8000-0000000000f1', family_id: FAMILY_A, member_id: CHILD_A, guardian_phone: '+15555550101', is_active: true, ai_persona_name: 'Guardian' },
    { id: 'b0000000-0000-4000-8000-0000000000f1', family_id: FAMILY_B, member_id: CHILD_B, guardian_phone: '+15555550102', is_active: true, ai_persona_name: 'Guardian' },
  ]);
  store.seed('guardian_communications', [
    { id: COMM_A, family_id: FAMILY_A, member_id: CHILD_A, status: 'screening', from_number: CALLER },
    { id: COMM_B, family_id: FAMILY_B, member_id: CHILD_B, status: 'screening', from_number: CALLER },
  ]);
  store.seed('guardian_screening_sessions', [
    { id: SESSION_A, family_id: FAMILY_A, communication_id: COMM_A, twilio_call_sid: `CA${'9'.repeat(32)}`, caller_number: CALLER, turn: 0, status: 'active', messages: [] },
    { id: SESSION_B, family_id: FAMILY_B, communication_id: COMM_B, twilio_call_sid: CALL_SID, caller_number: CALLER, turn: 0, status: 'active', messages: [] },
  ]);
  return store;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key-for-tests');
  modelAnswer = async () => Response.json({ choices: [{ message: { content: `Connecting you now. ${DECISION}` } }] });
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).startsWith('https://api.openai.com/')) return modelAnswer();
    throw new Error('live transport is prohibited in this test');
  }));
  db = seed();
  seam.db = db;
  seam.cookieClient.mockReset();
  seam.sms.length = 0;
  seam.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function expectNothingReached() {
  expect(db.log).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(seam.cookieClient).not.toHaveBeenCalled();
  expect(db.table('guardian_screening_sessions').every((row) => row.status === 'active' && row.turn === 0)).toBe(true);
}

describe('POST /api/guardian/screen: who may call it', () => {
  it('API-5A16104BF051 an unsigned turn is refused 401 and reaches no table, no model and no phone, even with a member session cookie', async () => {
    const response = await deliver(post(path(), form(), { cookie: 'sb-access-token=fake-session-of-parent-b' }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });

  it('API-5A16104BF051 a turn signed with the wrong token is refused 401', async () => {
    const response = await deliver(post(path(), form(), { 'x-twilio-signature': signature(form(), path(), 'fake-wrong-token') }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expectNothingReached();
  });

  it('API-5A16104BF051 a signature for B\'s session cannot be replayed against A\'s session id or another turn (the query is signed)', async () => {
    const forB = signature(form(), path(SESSION_B, 1));
    expect((await deliver(post(path(SESSION_A, 1), form(), { 'x-twilio-signature': forB }))).status).toBe(401);
    expect((await deliver(post(path(SESSION_B, 2), form(), { 'x-twilio-signature': forB }))).status).toBe(401);
    expectNothingReached();
  });
});

describe('POST /api/guardian/screen: a signed turn end to end', () => {
  it('API-5A16104BF051 a transfer decision dials B\'s member, resolves B\'s session and communication, and tells only household B', async () => {
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('<Dial');
    expect(xml).toContain(CHILD_B_PHONE);
    expect(xml).not.toContain(CHILD_A_PHONE);
    expect(modelCalls()).toHaveLength(1);

    const [session] = rowsOf('guardian_screening_sessions', FAMILY_B);
    expect(session).toMatchObject({ status: 'resolved', final_action: 'transfer', turn: 1, ai_risk: 'safe', ai_urgency: 'medium', caller_name_stated: 'Relative' });
    expect(session.messages).toEqual([{ role: 'caller', content: SPEECH }, { role: 'assistant', content: 'Connecting you now.' }]);
    expect(rowsOf('guardian_communications', FAMILY_B)).toEqual([expect.objectContaining({ id: COMM_B, status: 'handled', ai_decision_reason: 'A relative is checking in.' })]);
    expect(db.table('notifications')).toEqual([
      expect.objectContaining({ family_id: FAMILY_B, related_type: 'guardian_communications', related_id: COMM_B, body: 'A relative is checking in.' }),
    ]);
    expect(db.table('guardian_callback_events')).toEqual([
      expect.objectContaining({ event_id: `${CALL_SID}:screen:1`, callback_type: 'screening_gather' }),
    ]);

    // Household A's session and communication are exactly as seeded.
    expect(rowsOf('guardian_screening_sessions', FAMILY_A)).toEqual([expect.objectContaining({ status: 'active', turn: 0, messages: [] })]);
    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([expect.objectContaining({ status: 'screening' })]);
    expect(seam.sms).toEqual([]);
    expect(seam.calls).toEqual([]);
  });

  it('API-5A16104BF051 a replayed signed turn says goodbye without asking the model again or writing a second notice', async () => {
    expect((await deliver(signedPost())).status).toBe(200);
    const sessionReads = db.log.filter((entry) => entry.table === 'guardian_screening_sessions').length;
    const replay = await deliver(signedPost());
    // The callback claim answers the replay before the session is even read.
    expect(db.log.filter((entry) => entry.table === 'guardian_screening_sessions')).toHaveLength(sessionReads);
    expect(replay.status).toBe(200);
    const xml = await replay.text();
    expect(xml).toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
    expect(modelCalls()).toHaveLength(1);
    expect(db.table('notifications')).toHaveLength(1);
  });
});

describe('POST /api/guardian/screen: failure', () => {
  it('API-5A16104BF051 a model call that fails takes no decision: the caller is asked again, nothing is resolved or announced, and no internal text is spoken', async () => {
    modelAnswer = async () => { throw new Error('private provider detail must never be spoken'); };
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('<Gather');
    expect(xml).toContain(`sessionId=${SESSION_B}&amp;turn=2`);
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain('private provider detail');
    expect(modelCalls()).toHaveLength(1);
    const sessions = rowsOf('guardian_screening_sessions', FAMILY_B);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'active', turn: 1 });
    expect(sessions[0].final_action).toBeUndefined();
    expect(sessions[0].messages).toEqual([{ role: 'caller', content: SPEECH }, { role: 'assistant', content: expect.any(String) }]);
    expect(rowsOf('guardian_communications', FAMILY_B)).toEqual([expect.objectContaining({ status: 'screening' })]);
    expect(db.table('notifications')).toEqual([]);
  });
});
