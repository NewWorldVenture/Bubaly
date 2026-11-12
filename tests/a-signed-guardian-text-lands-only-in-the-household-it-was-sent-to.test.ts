// A signed Guardian text lands only in the household whose number it was sent to.
//
// POST /api/guardian/inbound/sms is a public Twilio webhook: the request
// signature is the whole authorization boundary, and the `To` number decides
// which household the text is filed under. These drive the real route over the
// in-memory database seeded with two households, with only the scam model, the
// generic notify service and Twilio's REST sends stubbed (the same seams
// tests/an-emergency-text-reaches-a-manager.test.ts stubs).
//
// Already pinned elsewhere, not repeated here: an invalid production signature
// creating no database client, duplicates, lease and ledger recovery
// (tests/guardian-sms-intake-execution.test.ts); the signed-URL candidates and
// the unconfigured-token refusal at the helper level
// (tests/twilio-ingress-verifies-everywhere.test.ts); emergency escalation from
// a text (tests/an-emergency-text-reaches-a-manager.test.ts).
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ service: vi.fn(), scam: vi.fn(), notify: vi.fn(), sms: [] as string[], calls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: async (to: string) => { seam.sms.push(to); },
  initiateCall: async ({ to }: { to: string }) => { seam.calls.push(to); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const PATH = '/api/guardian/inbound/sms';
const TOKEN = 'test-fake-twilio-token';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CHILD_A = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const CHILD_B = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const PARENT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const PARENT_B = 'bbbbbbbb-0000-4000-8000-0000000000a1';
const PROFILE_A = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const PROFILE_B = 'bbbbbbbb-0000-4000-8000-0000000000f1';
const CROSSED = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const NUMBER_A = '+15555550100';
const NUMBER_B = '+15555550101';
const NUMBER_CROSSED = '+15555550102';
const SENDER = '+15555550199';
const SID = `SM${'a'.repeat(32)}`;
const ROUTINE = 'See you at dinner';

let db: InMemorySupabase;

function guardianProfile(id: string, family: string, member: string, phone: string) {
  return {
    id, family_id: family, member_id: member, guardian_phone: phone, is_active: true,
    ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
    emergency_always_ring: true,
  };
}

function form(to: string, body = ROUTINE): Record<string, string> {
  return { From: SENDER, To: to, Body: body, SmsSid: SID, MessageSid: SID };
}

function sign(fields: Record<string, string>): string {
  const sorted = Object.keys(fields).sort().map((key) => `${key}${fields[key]}`).join('');
  return createHmac('sha1', TOKEN).update(`${ORIGIN}${PATH}${sorted}`).digest('base64');
}

async function deliver(fields: Record<string, string>, signature: string | null): Promise<[Response, string]> {
  const { POST } = await import('@/app/api/guardian/inbound/sms/route');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  const res = await POST(new NextRequest(`${ORIGIN}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }));
  return [res, await res.text()];
}

/** One table answers every call with a RESOLVED error, the way PostgREST does. */
function refuse(client: InMemorySupabase, table: string, message: string): void {
  const before = client.from.bind(client);
  const reply = { data: null, error: { code: '42501', message }, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === table ? chain : before(name))) as InMemorySupabase['from'];
}

const ofFamily = (table: string, family: string) => db.table(table).filter((row) => row.family_id === family);

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  seam.sms.length = 0; seam.calls.length = 0;
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']], guardian_escalations: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: CHILD_A, family_id: FAMILY_A, user_id: 'u-child-a', display_name: 'Kid A', is_active: true, role: 'child' },
    { id: PARENT_A, family_id: FAMILY_A, user_id: 'u-parent-a', display_name: 'Ada', is_active: true, role: 'parent' },
    { id: CHILD_B, family_id: FAMILY_B, user_id: 'u-child-b', display_name: 'Kid B', is_active: true, role: 'child' },
    { id: PARENT_B, family_id: FAMILY_B, user_id: 'u-parent-b', display_name: 'Bea', is_active: true, role: 'parent' },
  ]);
  db.seed('profiles', [{ id: 'u-parent-a', phone: '+15555550110' }, { id: 'u-parent-b', phone: '+15555550111' }]);
  db.seed('guardian_member_profiles', [
    guardianProfile(PROFILE_A, FAMILY_A, CHILD_A, NUMBER_A),
    guardianProfile(PROFILE_B, FAMILY_B, CHILD_B, NUMBER_B),
  ]);
  seam.service.mockReset();
  seam.service.mockImplementation(() => db);
  seam.scam.mockReset(); seam.notify.mockReset();
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('who may call it: Twilio, proven by its signature (member roles n/a: public webhook)', () => {
  it('API-BBD0A5DB630F an unsigned text is refused 401 before any database client exists, and nothing is written or sent', async () => {
    const [res, body] = await deliver(form(NUMBER_A), null);
    expect(res.status).toBe(401);
    expect(body).toBe('Unauthorized');
    expect(seam.service).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(db.table('guardian_communications')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
    expect([...seam.sms, ...seam.calls]).toEqual([]);
  });

  it('API-BBD0A5DB630F a signature made with the wrong token is refused 401, and nothing is written', async () => {
    const fields = form(NUMBER_A);
    const forged = createHmac('sha1', 'test-fake-wrong-token').update(`${ORIGIN}${PATH}${Object.keys(fields).sort().map((k) => `${k}${fields[k]}`).join('')}`).digest('base64');
    const [res] = await deliver(fields, forged);
    expect(res.status).toBe(401);
    expect(seam.service).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
  });

  it('API-BBD0A5DB630F a signature for one household\'s number does not carry over to a text re-addressed to the other', async () => {
    const [res] = await deliver(form(NUMBER_B), sign(form(NUMBER_A)));
    expect(res.status).toBe(401);
    expect(db.log).toEqual([]);
    expect(ofFamily('guardian_communications', FAMILY_B)).toEqual([]);
  });
});

describe('a correctly signed text, end to end', () => {
  it('API-BBD0A5DB630F is filed under household A, announced to A, acknowledged with an empty 200, and touches nothing of B', async () => {
    const [res, body] = await deliver(form(NUMBER_A), sign(form(NUMBER_A)));
    expect(res.status).toBe(200);
    expect(body).toBe('');

    const comms = db.table('guardian_communications');
    expect(comms).toHaveLength(1);
    expect(comms[0]).toMatchObject({
      family_id: FAMILY_A, member_id: CHILD_A, comm_type: 'sms_inbound', direction: 'inbound',
      from_number: SENDER, to_number: NUMBER_A, body: ROUTINE, twilio_sms_sid: SID,
    });
    expect(comms[0].status, 'the decision was written, not left pending').toBe('received');
    const notices = db.table('notifications');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ family_id: FAMILY_A, user_id: null, related_type: 'guardian_communications', related_id: comms[0].id });
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ callback_type: 'inbound_sms', status: 'processed' })]);

    expect(ofFamily('guardian_communications', FAMILY_B)).toEqual([]);
    expect(ofFamily('notifications', FAMILY_B)).toEqual([]);
    expect(db.table('guardian_escalations')).toEqual([]);
    expect([...seam.sms, ...seam.calls], 'a routine text texts and calls nobody').toEqual([]);
  });
});

describe('another household\'s number and members', () => {
  it('API-BBD0A5DB630F a text to household B\'s number is filed under B only, and nothing lands in A', async () => {
    const [res] = await deliver(form(NUMBER_B), sign(form(NUMBER_B)));
    expect(res.status).toBe(200);
    expect(db.table('guardian_communications')).toEqual([expect.objectContaining({ family_id: FAMILY_B, member_id: CHILD_B, to_number: NUMBER_B })]);
    expect(db.table('notifications')).toEqual([expect.objectContaining({ family_id: FAMILY_B })]);
    expect(ofFamily('guardian_communications', FAMILY_A)).toEqual([]);
    expect(ofFamily('notifications', FAMILY_A)).toEqual([]);
  });

  it('API-BBD0A5DB630F a Guardian number whose profile in A names household B\'s child is refused: nothing filed under either household', async () => {
    db.seed('guardian_member_profiles', [guardianProfile(CROSSED, FAMILY_A, CHILD_B, NUMBER_CROSSED)]);
    const [res, body] = await deliver(form(NUMBER_CROSSED), sign(form(NUMBER_CROSSED)));
    expect(res.status).toBe(503);
    expect(body).toBe('Intake unavailable');
    expect(db.table('guardian_communications')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('ai_tool_calls')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    expect([...seam.sms, ...seam.calls]).toEqual([]);
  });
});

describe('a failed read', () => {
  it('API-BBD0A5DB630F an unreadable destination lookup is 503 "Intake unavailable" with no internal error text, and nothing filed', async () => {
    refuse(db, 'guardian_member_profiles', 'permission denied for table guardian_member_profiles');
    const [res, body] = await deliver(form(NUMBER_A), sign(form(NUMBER_A)));
    expect(res.status).toBe(503);
    expect(body).toBe('Intake unavailable');
    expect(body).not.toContain('permission denied');
    expect(db.table('guardian_communications')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('guardian_callback_events').filter((row) => row.status === 'processed'), 'not acknowledged as handled').toEqual([]);
  });

  it('API-BBD0A5DB630F a service client that cannot be built is 503, not a 500 with its message', async () => {
    seam.service.mockImplementation(() => { throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set'); });
    const [res, body] = await deliver(form(NUMBER_A), sign(form(NUMBER_A)));
    expect(res.status).toBe(503);
    expect(body).toBe('Intake unavailable');
  });
});
