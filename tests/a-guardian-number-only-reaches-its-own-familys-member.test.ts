// A Guardian number is one family's, and so is the member behind it.
//
// guardian_member_profiles names its member by id alone — a plain FK to
// family_members(id), and the RLS policy checks only the row's own family_id —
// so a manager of family A could write family B's child into A's profile (an
// id they hold as a co-parent or member of a second family). The voice webhook
// then read that member's display_name and phone by id, with the service role
// and no family filter, greeted callers with the B child's name and, on
// immediate_ring, dialled the B child straight through: B's screening skipped,
// the caller's number hidden behind A's Guardian number. The SMS lane refused
// the case (ownsDestination checks family_members.family_id); the voice lane
// and the server actions that write the profile did not.
//
// Two layers pinned here: the actions refuse a member (or a rule's contact)
// that is not the caller's family's, and the voice route refuses to route a
// profile whose member is not in the profile's family.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const C = vi.hoisted(() => ({
  FAMILY_A: '11111111-1111-4111-8111-111111111111',
  FAMILY_B: '22222222-2222-4222-8222-222222222222',
  MEMBER_A: '33333333-3333-4333-8333-333333333333',
  MEMBER_B: '44444444-4444-4444-8444-444444444444',
  CONTACT_B: '55555555-5555-4555-8555-555555555555',
}));
const seam = vi.hoisted(() => ({ service: vi.fn(), server: vi.fn(), pipeline: vi.fn(), turn: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service, createServer: seam.server }));
vi.mock('@/lib/supabase/auth', () => ({
  // A manager of family A.
  requireUserContext: async () => ({
    user: { id: 'u-manager-a', email: null }, memberships: [],
    active: { familyId: C.FAMILY_A, role: 'parent', family: { id: C.FAMILY_A, timezone: 'UTC' }, member: { id: C.MEMBER_A, family_id: C.FAMILY_A, display_name: 'Ada' } },
  }),
}));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/twilio', async (original) => ({ ...await original<typeof import('@/lib/guardian/twilio')>(), lookupCallerName: async () => null }));
vi.mock('@/lib/guardian/ai-screen', () => ({ buildInitialGreeting: () => 'hello', buildVoicemailPrompt: () => 'leave a message', screeningTurn: seam.turn, summarizeScreening: async () => 'summary' }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: async () => ({ isScam: false, scamType: null, confidence: 0 }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const GUARDIAN = '+15555550100';
const CALLER = '+15555550199';
const PHONE_A = '+15550000001';
const PHONE_B = '+15550000002';
const CALL = `CA${'b'.repeat(32)}`;

const profile = (memberId: string) => ({
  id: '66666666-6666-4666-8666-666666666666', family_id: C.FAMILY_A, member_id: memberId, guardian_phone: GUARDIAN, is_active: true,
  ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
  default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
  default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
});

let db: InMemorySupabase;
let errors: unknown[][];

function signedVoice(): NextRequest {
  const url = `${ORIGIN}/api/guardian/inbound/voice`;
  const form: Record<string, string> = { CallSid: CALL, From: CALLER, To: GUARDIAN, CallStatus: 'ringing' };
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(form).toString(),
  });
}

const WA_SID = `SM${'d'.repeat(32)}`;
const SESSION = '77777777-7777-4777-8777-777777777777';
const COMM = '88888888-8888-4888-8888-888888888888';

function signedTwilio(path: string, form: Record<string, string>, query = ''): NextRequest {
  const url = `${ORIGIN}${path}${query}`;
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(form).toString(),
  });
}
const signedWhatsApp = () => signedTwilio('/api/guardian/inbound/whatsapp', { SmsSid: WA_SID, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: 'hello, it is Grandma' });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], guardian_member_profiles: [['family_id', 'member_id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  // Two families, one member each. Nothing but the family filter tells them apart.
  db.seed('families', [{ id: C.FAMILY_A, name: 'Family A', timezone: 'UTC' }, { id: C.FAMILY_B, name: 'Family B', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: C.MEMBER_A, family_id: C.FAMILY_A, display_name: 'Ada', phone: PHONE_A, is_active: true, role: 'child' },
    { id: C.MEMBER_B, family_id: C.FAMILY_B, display_name: 'Bea', phone: PHONE_B, is_active: true, role: 'child' },
  ]);
  db.seed('guardian_contacts', [{ id: C.CONTACT_B, family_id: C.FAMILY_B, phone: '+15550009999', name: 'B contact', trust_level: 'known_contact' }]);
  errors = [];
  seam.service.mockImplementation(() => db);
  seam.server.mockImplementation(async () => db);
  // Grandma: the profile's immediate-family default rings straight through.
  seam.pipeline.mockResolvedValue({
    contactId: null, contactName: 'Grandma', trustLevel: 'immediate_family', routingMode: 'immediate_ring', spamScore: 0,
    scamDetected: false, scamType: null, ruleId: null, reason: 'Immediate family', shouldEscalate: false, emergencyKeywords: false, memberProfile: null,
  });
  seam.pipeline.mockClear(); seam.turn.mockReset(); seam.notify.mockReset();
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the voice webhook routes only to a member of the profile\'s own family', () => {
  it('refuses a Guardian number whose profile names another family\'s member, instead of dialling that child', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_B)]);
    const { POST } = await import('@/app/api/guardian/inbound/voice/route');
    const res = await POST(signedVoice());
    const body = await res.text();
    expect(res.status).toBe(200);
    // The defect: this was `<Dial>+15550000002</Dial>` — family B's child,
    // connected through family A's number with no screening of their own.
    expect(body).not.toContain('<Dial');
    expect(body).not.toContain(PHONE_B);
    expect(body).toContain('<Hangup');
    expect(seam.pipeline, 'no routing decision is even made for a profile that is not the family\'s').not.toHaveBeenCalled();
    expect(db.table('guardian_communications')).toEqual([]);
    expect(errors.some((args) => /names a member outside its family/.test(String(args[0])))).toBe(true);
    // Refused, not retried: a retry cannot make the member the family's.
    expect(db.table('guardian_callback_events')[0]).toMatchObject({ event_id: CALL, status: 'processed' });
  });

  it('still connects an immediate-family caller to the family\'s own member (positive control)', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const { POST } = await import('@/app/api/guardian/inbound/voice/route');
    const res = await POST(signedVoice());
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('<Dial');
    expect(body).toContain(PHONE_A);
    expect(body).not.toContain(PHONE_B);
  });
});

describe('the Guardian settings actions refuse a member who is not the caller\'s family\'s', () => {
  it('assignGuardianPhoneAction does not create a profile for another family\'s member', async () => {
    const { assignGuardianPhoneAction } = await import('@/app/(app)/guardian/actions');
    const result = await assignGuardianPhoneAction({ member_id: C.MEMBER_B, phone: GUARDIAN });
    expect(result).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(db.table('guardian_member_profiles'), 'nothing is written').toEqual([]);

    const own = await assignGuardianPhoneAction({ member_id: C.MEMBER_A, phone: GUARDIAN });
    expect(own).toEqual({ ok: true, data: { phone: GUARDIAN } });
    expect(db.table('guardian_member_profiles')).toEqual([expect.objectContaining({ family_id: C.FAMILY_A, member_id: C.MEMBER_A, guardian_phone: GUARDIAN })]);
  });

  it('upsertMemberProfileAction does the same', async () => {
    const { upsertMemberProfileAction } = await import('@/app/(app)/guardian/actions');
    expect(await upsertMemberProfileAction({ member_id: C.MEMBER_B, ai_persona_name: 'Buddy' })).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(db.table('guardian_member_profiles')).toEqual([]);
    expect(await upsertMemberProfileAction({ member_id: C.MEMBER_A, ai_persona_name: 'Buddy' })).toEqual({ ok: true });
    expect(db.table('guardian_member_profiles')).toHaveLength(1);
  });

  it('a removed member of the family is not one either', async () => {
    db.replace('family_members', [{ id: C.MEMBER_A, family_id: C.FAMILY_A, display_name: 'Ada', phone: PHONE_A, is_active: false, role: 'child' }]);
    const { assignGuardianPhoneAction } = await import('@/app/(app)/guardian/actions');
    expect(await assignGuardianPhoneAction({ member_id: C.MEMBER_A, phone: GUARDIAN })).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(db.table('guardian_member_profiles')).toEqual([]);
  });

  it('a contact\'s member and a rule\'s member or conditioned contact must be the family\'s too', async () => {
    const { upsertContactAction, createRuleAction } = await import('@/app/(app)/guardian/actions');
    expect(await upsertContactAction({ name: 'Coach', phone: '+15550001234', trust_level: 'known_contact', member_id: C.MEMBER_B }))
      .toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(db.table('guardian_contacts').filter((row) => row.family_id === C.FAMILY_A)).toEqual([]);

    expect(await createRuleAction({ name: 'Quiet', action_routing_mode: 'silent_handling', member_id: C.MEMBER_B }))
      .toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(await createRuleAction({ name: 'Block them', action_routing_mode: 'blocked', condition_contact_id: C.CONTACT_B }))
      .toEqual({ ok: false, error: 'actions.contactNotFound' });
    expect(db.table('guardian_routing_rules')).toEqual([]);

    const own = await createRuleAction({ name: 'Quiet', action_routing_mode: 'silent_handling', member_id: C.MEMBER_A });
    expect(own.ok).toBe(true);
    expect(db.table('guardian_routing_rules')).toEqual([expect.objectContaining({ family_id: C.FAMILY_A, member_id: C.MEMBER_A })]);
  });
});

describe('the WhatsApp webhook records and announces only for a member of the profile\'s own family', () => {
  it('refuses a Guardian number whose profile names another family\'s member, instead of recording and announcing under them', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_B)]);
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    const res = await POST(signedWhatsApp());
    expect(res.status).toBe(200);
    // The defect: the message was recorded under family B's child, with
    // family A's number as its destination, and family A was notified.
    expect(seam.pipeline, 'no routing decision is made for a profile that is not the family\'s').not.toHaveBeenCalled();
    expect(db.table('guardian_communications')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    expect(errors.some((args) => /names a member outside its family/.test(String(args[0])))).toBe(true);
    // Refused, not retried: a retry cannot make the member the family's.
    expect(db.table('guardian_callback_events')[0]).toMatchObject({ event_id: WA_SID, status: 'processed' });
  });

  it('a removed member of the family is not one either', async () => {
    db.replace('family_members', db.table('family_members').map((row) => (row.id === C.MEMBER_A ? { ...row, is_active: false } : row)));
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    expect((await POST(signedWhatsApp())).status).toBe(200);
    expect(seam.pipeline).not.toHaveBeenCalled();
    expect(db.table('guardian_communications')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    expect(db.table('guardian_callback_events')[0]).toMatchObject({ event_id: WA_SID, status: 'processed' });
  });

  it('asks Twilio to retry when the member cannot be looked up, giving the claim back', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const before = db.from.bind(db);
    const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
        return () => chain;
      },
    });
    db.from = ((name: string) => (name === 'family_members' ? chain : before(name))) as InMemorySupabase['from'];
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    expect((await POST(signedWhatsApp())).status).toBe(503);
    expect(seam.pipeline).not.toHaveBeenCalled();
    expect(db.table('guardian_callback_events'), 'the claim was given back so the retry is processed').toEqual([]);
  });

  it('still records and announces a message to the family\'s own member (positive control)', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    expect((await POST(signedWhatsApp())).status).toBe(200);
    expect(seam.pipeline).toHaveBeenCalledOnce();
    expect(db.table('guardian_communications')).toEqual([expect.objectContaining({ family_id: C.FAMILY_A, member_id: C.MEMBER_A, twilio_sms_sid: WA_SID })]);
    expect(seam.notify).toHaveBeenCalledOnce();
  });
});

describe('the screening callback dials only an active member of the family', () => {
  const screenedTransfer = async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: C.FAMILY_A, member_id: C.MEMBER_A, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: C.FAMILY_A, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue({ responseText: 'Connecting you now.', decision: { action: 'transfer', risk: 'safe', urgency: 'medium', intent: 'personal', summary: 'Grandma calling.', callerName: 'Grandma' } });
    const { POST } = await import('@/app/api/guardian/screen/route');
    const res = await POST(signedTwilio('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Hi, it is Grandma.' }, `?sessionId=${SESSION}&turn=1`));
    expect(res.status).toBe(200);
    return res.text();
  };

  it('does not dial a member who has been removed from the family, even with a phone still on file', async () => {
    db.replace('family_members', db.table('family_members').map((row) => (row.id === C.MEMBER_A ? { ...row, is_active: false } : row)));
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const xml = await screenedTransfer();
    // The defect: `<Dial>+15550000001</Dial>` — a removed member's phone,
    // dialled through the family's Guardian number.
    expect(xml).not.toContain('<Dial');
    expect(xml).not.toContain(PHONE_A);
    expect(xml).toContain('<Record');
  });

  it('still dials the family\'s own active member (positive control)', async () => {
    db.seed('guardian_member_profiles', [profile(C.MEMBER_A)]);
    const xml = await screenedTransfer();
    expect(xml).toContain('<Dial');
    expect(xml).toContain(PHONE_A);
  });
});
