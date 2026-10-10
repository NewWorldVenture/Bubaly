// A Guardian number rings only its own family's member.
//
// `guardian_member_profiles` is what maps a Guardian number to a person: the
// inbound voice callback reads the profile's member and, for a caller the
// family trusts, `<Dial>`s that member's phone, greeting with their name. The
// table's write policy checks only the row's own `family_id`, so a household
// could save a profile carrying ANOTHER family's member id (measured on a
// replay as a parent under RLS: 1 row, while that parent read 0 rows of the
// member). The profile actions upserted whatever member id the client sent,
// and the callbacks, which run with the service role, read the member by id
// alone. One household's Guardian number became a relay to a stranger's phone,
// a child's included, without the number ever being shown.
//
// These drive the real routes and actions. The negative control in each half
// is the family's own member, who must still be dialled and saved, or every
// refusal below would be satisfied by a route that dials nobody.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000a0001';
const OTHER_FAMILY = '00000000-0000-4000-8000-0000000b0001';
const PARENT_USER = '00000000-0000-4000-8000-0000000a00aa';
const GUARDIAN_NUMBER = '+15550000000';
const OWN_PHONE = '+15550001111';
const STRANGER_PHONE = '+15550009999';
const SESSION = '00000000-0000-4000-8000-0000000a0c51';
const COMM = '00000000-0000-4000-8000-0000000a0cc1';

type Db = ReturnType<typeof createInMemorySupabase>;
const state = vi.hoisted(() => ({
  db: null as unknown,
  routingMode: 'immediate_ring' as string,
  screenedName: null as string | null,
  memberReadFails: false,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => state.db,
  // The action's own session. When asked to, its member read fails, so the
  // action's read-error path is exercised rather than assumed.
  createServer: async () => (state.memberReadFails
    ? new Proxy(state.db as object, {
      get: (target, prop) => (prop === 'from'
        ? (name: string) => (name === 'family_members'
          ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'permission denied', code: '42501' } }) }) }) }) }
          : (target as { from: (n: string) => unknown }).from(name))
        : (target as Record<string | symbol, unknown>)[prop]),
    })
    : state.db),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: PARENT_USER }, active: { familyId: FAMILY, role: 'parent', member: { id: 'm-parent' } } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/server/twilio-ingress', () => ({
  verifyTwilioRequest: () => ({ ok: true, via: 'signature' }),
  twilioRefusal: () => new Response('', { status: 403 }),
}));
vi.mock('@/lib/guardian/twilio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guardian/twilio')>()),
  lookupCallerName: async () => null,
}));
// The pipeline's routing decision is the test's to choose: immediate_ring is
// the branch that dials, and ai_handle_first and voicemail_first are the
// branches that SPEAK the member's name (immediate_ring never does).
vi.mock('@/lib/guardian/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guardian/pipeline')>()),
  runDecisionPipeline: async () => ({
    routingMode: state.routingMode, memberProfile: null, contactName: 'Grandma', trustLevel: 'trusted',
    ruleId: null, reason: 'trusted caller', scamDetected: false, scamType: null, spamScore: 0,
  }),
}));
vi.mock('@/lib/guardian/ai-screen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/guardian/ai-screen')>()),
  screeningTurn: async ({ memberName }: { memberName: string }) => {
    state.screenedName = memberName;
    return {
    responseText: 'Connecting you now.',
    decision: { action: 'transfer', risk: 'safe', urgency: 'medium', intent: 'personal', summary: 'Grandma calling.', callerName: 'Grandma' },
    };
  },
  summarizeScreening: async () => 'summary',
}));

function freshDb(profileMember: 'm-own' | 'm-stranger'): Db {
  const db = createInMemorySupabase({ uniques: { guardian_callback_events: [['event_id']] } });
  db.seed('families', [{ id: FAMILY, name: 'Our House' }, { id: OTHER_FAMILY, name: 'Their House' }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: PARENT_USER, display_name: 'Parent', role: 'parent', is_active: true },
    { id: 'm-own', family_id: FAMILY, display_name: 'Own Kid', role: 'child', phone: OWN_PHONE, is_active: true },
    { id: 'm-stranger', family_id: OTHER_FAMILY, display_name: 'Stranger Kid', role: 'child', phone: STRANGER_PHONE, is_active: true },
  ]);
  db.seed('guardian_member_profiles', [
    { id: 'p-1', family_id: FAMILY, member_id: profileMember, guardian_phone: GUARDIAN_NUMBER, is_active: true },
  ]);
  return db;
}

async function inboundCall(): Promise<string> {
  const { POST } = await import('@/app/api/guardian/inbound/voice/route');
  const body = new URLSearchParams({
    CallSid: 'CA00000000000000000000000000000071', From: '+15557770000', To: GUARDIAN_NUMBER, CallStatus: 'ringing',
  });
  const response = await POST(new NextRequest('https://app.example.test/api/guardian/inbound/voice', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
  expect(response.status).toBe(200);
  return response.text();
}

async function screenedTurn(): Promise<string> {
  const db = state.db as Db;
  db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: (db.table('guardian_member_profiles')[0] as { member_id: string }).member_id, status: 'screening' }]);
  db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: 'CA0071', caller_number: '+15557770000', turn: 0, status: 'active', messages: [] }]);
  const { POST } = await import('@/app/api/guardian/screen/route');
  const body = new URLSearchParams({ CallSid: 'CA00000000000000000000000000000072', SpeechResult: 'Hi, it is Grandma.' });
  const response = await POST(new NextRequest(`https://app.example.test/api/guardian/screen?sessionId=${SESSION}&turn=1`, {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }));
  expect(response.status).toBe(200);
  return response.text();
}

beforeEach(() => {
  state.routingMode = 'immediate_ring';
  state.screenedName = null;
  state.memberReadFails = false;
});

// The voice route reads the member twice, each within the number's family:
// its display name (spoken by the greeting and the voicemail prompt) and its
// phone (dialled on immediate_ring). Each case below is decided by exactly one
// of those reads, so removing either filter fails its own case.
describe('the inbound call is put through only to the number\'s own family (phone read)', () => {
  it('control: a trusted caller is dialled through to the family\'s own member', async () => {
    state.db = freshDb('m-own');
    const xml = await inboundCall();
    expect(xml).toContain('<Dial');
    expect(xml).toContain(OWN_PHONE);
  });

  it('a profile naming another family\'s member dials nobody: the call is thanked and hung up', async () => {
    state.db = freshDb('m-stranger');
    const xml = await inboundCall();
    expect(xml).not.toContain(STRANGER_PHONE);
    expect(xml).not.toContain('<Dial');
    // With no phone in the number's family, immediate_ring falls through to the
    // route's default: a thank-you and a hang-up. It is not screened.
    expect(xml).toContain('voice.thankYouForCallingWe');
    expect(xml).toContain('<Hangup');
  });
});

describe('the inbound call speaks only the number\'s own family member\'s name (name read)', () => {
  it.each(['ai_handle_first', 'voicemail_first'])('control: %s speaks the family\'s own member\'s name', async (mode) => {
    state.routingMode = mode;
    state.db = freshDb('m-own');
    const xml = await inboundCall();
    expect(xml).toContain('Own Kid');
  });

  it.each(['ai_handle_first', 'voicemail_first'])('%s never speaks another family\'s member\'s name', async (mode) => {
    state.routingMode = mode;
    state.db = freshDb('m-stranger');
    const xml = await inboundCall();
    expect(xml).not.toContain('Stranger Kid');
    expect(xml).toContain('the family');
  });
});

describe('the screened call names and transfers only to the number\'s own family', () => {
  it('control: the screening turn is given the family\'s own member\'s name, and the transfer dials them', async () => {
    state.db = freshDb('m-own');
    const xml = await screenedTurn();
    expect(state.screenedName).toBe('Own Kid');
    expect(xml).toContain('<Dial');
    expect(xml).toContain(OWN_PHONE);
  });

  it('a profile naming another family\'s member is neither named to the screener nor dialled', async () => {
    state.db = freshDb('m-stranger');
    const xml = await screenedTurn();
    expect(state.screenedName).toBe('the family member');
    expect(xml).not.toContain(STRANGER_PHONE);
  });
});

describe('the profile actions save only a member of the caller\'s own family', () => {
  beforeEach(() => {
    state.db = freshDb('m-own');
    (state.db as Db).seed('guardian_member_profiles', []);
  });
  const profilesFor = (member: string) =>
    (state.db as Db).table('guardian_member_profiles').filter((r) => (r as { member_id: string }).member_id === member);

  it('control: assigns a Guardian number to the family\'s own member', async () => {
    const { assignGuardianPhoneAction } = await import('@/app/(app)/guardian/actions');
    const result = await assignGuardianPhoneAction({ member_id: 'm-own', phone: '+15550002222' });
    expect(result.ok).toBe(true);
    expect(profilesFor('m-own').map((r) => (r as { guardian_phone: string }).guardian_phone)).toContain('+15550002222');
  });

  it('refuses to assign a Guardian number to another family\'s member', async () => {
    const { assignGuardianPhoneAction } = await import('@/app/(app)/guardian/actions');
    const result = await assignGuardianPhoneAction({ member_id: 'm-stranger', phone: '+15550003333' });
    expect(profilesFor('m-stranger')).toEqual([]);
    expect(result).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
  });

  it('control: saves routing for the family\'s own member', async () => {
    const { upsertMemberProfileAction } = await import('@/app/(app)/guardian/actions');
    const result = await upsertMemberProfileAction({ member_id: 'm-own', default_mode_trusted: 'immediate_ring' });
    expect(result.ok).toBe(true);
    expect(profilesFor('m-own')).toHaveLength(1);
  });

  it('refuses to save routing for another family\'s member', async () => {
    const { upsertMemberProfileAction } = await import('@/app/(app)/guardian/actions');
    const result = await upsertMemberProfileAction({ member_id: 'm-stranger', default_mode_trusted: 'immediate_ring' });
    expect(profilesFor('m-stranger')).toEqual([]);
    expect(result).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
  });

  it('refuses a member id that exists nowhere, writing nothing', async () => {
    const { assignGuardianPhoneAction } = await import('@/app/(app)/guardian/actions');
    const result = await assignGuardianPhoneAction({ member_id: 'm-nobody', phone: '+15550004444' });
    expect(profilesFor('m-nobody')).toEqual([]);
    expect(result).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
  });

  it.each(['assign', 'routing'])('a failed member read refuses the %s action and writes nothing', async (which) => {
    const actions = await import('@/app/(app)/guardian/actions');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = JSON.stringify((state.db as Db).table('guardian_member_profiles'));
    state.memberReadFails = true;
    const result = which === 'assign'
      ? await actions.assignGuardianPhoneAction({ member_id: 'm-own', phone: '+15550005555' })
      : await actions.upsertMemberProfileAction({ member_id: 'm-own', default_mode_trusted: 'immediate_ring' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify((state.db as Db).table('guardian_member_profiles'))).toBe(before);
    errors.mockRestore();
  });
});
