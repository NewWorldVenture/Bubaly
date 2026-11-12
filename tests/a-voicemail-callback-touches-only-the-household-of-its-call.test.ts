// A voicemail callback touches only the household of the call it belongs to,
// and only when Twilio signed it (Register B API-A3BF950AE646).
//
// The route is on the middleware public allowlist; the Twilio signature, over
// the full URL including `?commId=`, is its whole authorization boundary
// (lib/server/twilio-ingress.ts). These drive the real handler, the real
// signature check, the real voicemail lease and the real Guardian notice over
// an in-memory database seeded with two households, and read the tables back.
// `fetch` refuses every call; this route reaches no provider.
//
// Already proven elsewhere and not repeated: a correctly signed voicemail,
// its replay acknowledged once, a wrong signature touching no table, and a
// 503-then-recovery for each of seven failing stages (claim, communication
// read and write, scope, notice read and write, finish), lost responses,
// stolen leases, a transport that ignores cancellation and quiet hours
// (guardian-voicemail-intake-execution); the voicemail after a screened call
// (a-screened-voicemail-is-still-announced); body bounds and identifier
// shapes (raw-body-boundaries, guardian-callback-security); and a deployment
// with no TWILIO_AUTH_TOKEN refusing 503 (twilio-ingress-verifies-everywhere).
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, cookieClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db, createServer: seam.cookieClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-voicemail.example.com';
const TOKEN = 'fake-twilio-auth-token-for-tests';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const CHILD_A = 'a0000000-0000-4000-8000-0000000000c1';
const PARENT_A = 'a0000000-0000-4000-8000-0000000000d1';
const CHILD_B = 'b0000000-0000-4000-8000-0000000000c1';
const PARENT_B = 'b0000000-0000-4000-8000-0000000000d1';
const COMM_A = 'a0000000-0000-4000-8000-0000000000a1';
const COMM_B = 'b0000000-0000-4000-8000-0000000000a1';
const RECORDING_SID = `RE${'1'.repeat(32)}`;
const RECORDING_URL = 'https://api.twilio.example.com/recordings/fake-recording';
const TRANSCRIPT = 'Calling to confirm the dentist appointment on Friday.';

let db: InMemorySupabase;

const path = (commId: string | null = COMM_B) => `/api/guardian/status/voicemail${commId === null ? '' : `?commId=${commId}`}`;
const form = (overrides: Record<string, string> = {}) => ({
  RecordingSid: RECORDING_SID, RecordingUrl: RECORDING_URL, RecordingDuration: '30', TranscriptionText: TRANSCRIPT, ...overrides,
});

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
  const { POST } = await import('@/app/api/guardian/status/voicemail/route');
  return POST(request);
}

const rowsOf = (table: string, familyId: string) => db.table(table).filter((row) => row.family_id === familyId);
const SEEDED_COMM = { status: 'screening', from_number: '+15555550150', from_name: 'Dentist office' };

function seed(): InMemorySupabase {
  const store = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  store.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  store.seed('family_members', [
    { id: PARENT_A, family_id: FAMILY_A, user_id: 'user-parent-a', display_name: 'Parent A', role: 'parent', is_active: true },
    { id: CHILD_A, family_id: FAMILY_A, user_id: 'user-child-a', display_name: 'Child A', role: 'child', is_active: true },
    { id: PARENT_B, family_id: FAMILY_B, user_id: 'user-parent-b', display_name: 'Parent B', role: 'parent', is_active: true },
    { id: CHILD_B, family_id: FAMILY_B, user_id: 'user-child-b', display_name: 'Child B', role: 'child', is_active: true },
  ]);
  store.seed('guardian_communications', [
    { ...SEEDED_COMM, id: COMM_A, family_id: FAMILY_A, member_id: CHILD_A },
    { ...SEEDED_COMM, id: COMM_B, family_id: FAMILY_B, member_id: CHILD_B },
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
  expect(db.table('guardian_communications').every((row) => row.status === 'screening' && row.call_recording_url === undefined)).toBe(true);
}

describe('POST /api/guardian/status/voicemail: who may call it', () => {
  it('API-A3BF950AE646 an unsigned callback is refused 401 and reaches no table, even with a member session cookie', async () => {
    const response = await deliver(post(path(), form(), { cookie: 'sb-access-token=fake-session-of-parent-b' }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });

  it('API-A3BF950AE646 a signature for B\'s communication cannot be moved onto A\'s communication id (the query is signed)', async () => {
    const forB = signature(form(), path(COMM_B));
    const response = await deliver(post(path(COMM_A), form(), { 'x-twilio-signature': forB }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });

  it('API-A3BF950AE646 a signature cannot carry a different recording: the posted fields are signed', async () => {
    const response = await deliver(post(path(), form({ RecordingUrl: 'https://attacker.example.com/recording' }), { 'x-twilio-signature': signature(form(), path()) }));
    expect(response.status).toBe(401);
    expectNothingReached();
  });
});

describe('POST /api/guardian/status/voicemail: a signed callback end to end', () => {
  it('API-A3BF950AE646 saves the recording on B\'s communication, announces it to household B\'s members only, and leaves A untouched', async () => {
    const response = await deliver(signedPost());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(await response.text()).toContain('voicemail.thankYouForYourMessage');

    expect(rowsOf('guardian_communications', FAMILY_B)).toEqual([expect.objectContaining({
      id: COMM_B, status: 'handled', call_recording_url: RECORDING_URL, call_duration_secs: 30, body: TRANSCRIPT,
      summary: `Voicemail from Dentist office: "${TRANSCRIPT}"`,
    })]);
    // One family-wide notice (user_id null) under B, the shape notifyGuardianSms writes; RLS shows it to B's members only.
    expect(db.table('notifications')).toEqual([expect.objectContaining({
      family_id: FAMILY_B, user_id: null, related_type: 'guardian_communications', related_id: COMM_B, title: '📩 Voicemail from Dentist office',
    })]);
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: RECORDING_SID, status: 'processed' })]);

    expect(rowsOf('guardian_communications', FAMILY_A)).toEqual([expect.objectContaining({ ...SEEDED_COMM, id: COMM_A })]);
    expect(rowsOf('guardian_communications', FAMILY_A)[0].call_recording_url).toBeUndefined();
    expect(rowsOf('notifications', FAMILY_A)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('API-A3BF950AE646 a replay of the same recording, even re-signed onto A\'s communication, writes nothing to A and announces nothing twice', async () => {
    expect((await deliver(signedPost())).status).toBe(200);
    const noticesAfterFirst = db.table('notifications').length;
    // Twilio would never sign this, but the recording id is the receipt: the
    // same recording cannot be applied to a second communication.
    expect((await deliver(signedPost(path(COMM_A)))).status).toBe(503);
    expect((await deliver(signedPost())).status).toBe(200);
    expect(db.table('notifications')).toHaveLength(noticesAfterFirst);
    expect(rowsOf('guardian_communications', FAMILY_A)[0]).toMatchObject({ status: 'screening' });
    expect(rowsOf('guardian_communications', FAMILY_A)[0].call_recording_url).toBeUndefined();
  });

  it('API-A3BF950AE646 a voicemail with no communication (an unknown number) is thanked and writes nothing', async () => {
    const response = await deliver(signedPost(path(null)));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('voicemail.thankYouGoodbye');
    expect(db.log).toEqual([]);
  });

  it('API-A3BF950AE646 a signed callback naming a communication that does not exist answers 503, writes no notice and gives the lease back', async () => {
    const response = await deliver(signedPost(path('c0000000-0000-4000-8000-0000000000a9')));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: RECORDING_SID, status: 'error' })]);
    expect(db.table('guardian_communications').every((row) => row.status === 'screening')).toBe(true);
  });
});
