// An emergency text reaches a manager's phone, now, whatever the hour.
//
// runDecisionPipeline set shouldEscalate for "help me, there was an accident,
// call 911" — and nothing read it. The SMS processor and the WhatsApp route
// sent the message out as a routine family notice ("💬 Text from …"), which
// quiet hours hold until morning; nothing anywhere called /api/guardian/escalate,
// so its SMS-and-call alerting was unreachable; no guardian_escalations row was
// written; and if the scam model scored the text at 80 or above, both routes
// dropped it silently. A screened call the AI classified `emergency` got only an
// in-app row with user_id null.
//
// These run the real pipeline against the in-memory database with telephony
// stubbed, so the decision, the receipt ledger, the quiet-hours bypass, the
// escalation claim and the record are the real ones.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ service: vi.fn(), scam: vi.fn(), notify: vi.fn(), turn: vi.fn(), after: vi.fn(), sms: [] as string[], calls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
// Next's `after()`: outside a request scope (every test here) it throws, and
// the screening route then runs the escalation inline. One test stands in for
// a request scope and holds the task, the way Next does until the response is out.
vi.mock('next/server', async (original) => ({
  ...await original<typeof import('next/server')>(),
  after: (task: () => Promise<void>) => seam.after(task),
}));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/guardian/ai-screen', () => ({ screeningTurn: seam.turn, summarizeScreening: async () => 'Caller says grandpa collapsed.' }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: async (to: string) => { seam.sms.push(to); },
  initiateCall: async ({ to }: { to: string }) => { seam.calls.push(to); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const COMM = '66666666-6666-4666-8666-666666666666';
const GUARDIAN = '+15555550100';
const CALLER = '+15555550199';
const PARENT_PHONE = '+15550000777';
const EMERGENCY = 'help me, there was an accident, call 911';
const ROUTINE = 'see you at dinner';
const SMS_SID = `SM${'a'.repeat(32)}`;
const OTHER_SID = `SM${'b'.repeat(32)}`;
const CALL = `CA${'c'.repeat(32)}`;

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const escalations = () => db.table('guardian_escalations');
const notifications = () => db.table('notifications');

function signed(path: string, form: Record<string, string>, query = ''): NextRequest {
  const url = `${ORIGIN}${path}${query}`;
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(form).toString() });
}

async function sms(smsSid: string, body: string) {
  const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');
  return receiveGuardianSms(client(), { smsSid, from: CALLER, to: GUARDIAN, body });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  seam.sms.length = 0; seam.calls.length = 0;
  seam.after.mockReset();
  seam.after.mockImplementation(() => { throw new Error('`after` was called outside a request scope.'); });
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']], guardian_escalations: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: CHILD, family_id: FAMILY, user_id: 'u-child', display_name: 'Kid', phone: '+15550000001', is_active: true, role: 'child' },
    { id: PARENT, family_id: FAMILY, user_id: 'u-parent', display_name: 'Ada', is_active: true, role: 'parent' },
  ]);
  db.seed('profiles', [{ id: 'u-parent', phone: PARENT_PHONE }, { id: 'u-child', phone: '+15550000001' }]);
  db.seed('guardian_member_profiles', [{
    id: PROFILE, family_id: FAMILY, member_id: CHILD, guardian_phone: GUARDIAN, is_active: true,
    ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
    emergency_always_ring: true,
  }]);
  // Quiet hours that cover right now, so a routine text is held until morning.
  const hour = new Date().getUTCHours();
  db.seed('family_ai_settings', [{ family_id: FAMILY, quiet_hours_start: hour, quiet_hours_end: (hour + 3) % 24 }]);
  seam.service.mockImplementation(() => db);
  seam.scam.mockReset(); seam.notify.mockReset(); seam.turn.mockReset();
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('an emergency SMS', () => {
  it('texts and calls the managers, records the escalation, and is announced at once despite quiet hours', async () => {
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    // The defect, in order: no escalation row, no SMS, no call, and a routine
    // notification deferred to the end of quiet hours.
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ family_id: FAMILY, severity: 'critical', notified_member_ids: [PARENT], sms_sent: true, call_attempted: true, caller_number: CALLER });
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(seam.calls).toEqual([PARENT_PHONE]);
    const comm = db.table('guardian_communications').find((row) => row.twilio_sms_sid === SMS_SID);
    expect(comm).toMatchObject({ status: 'escalated' });
    expect(escalations()[0].communication_id).toBe(comm?.id);
    const alert = notifications().find((row) => String(row.title).startsWith('🚨 Emergency text from'));
    expect(alert).toBeTruthy();
    expect(Math.abs(Date.parse(String(alert!.send_at)) - Date.now()), 'sent now, not at the end of quiet hours').toBeLessThan(60_000);
  });

  it('a routine text in the same quiet hours is still held until morning (the fixture is live)', async () => {
    expect(await sms(OTHER_SID, ROUTINE)).toBe('completed');
    expect(escalations()).toEqual([]);
    expect(seam.sms).toEqual([]);
    const notice = notifications().find((row) => String(row.title).startsWith('💬 Text from'));
    expect(notice).toBeTruthy();
    expect(Date.parse(String(notice!.send_at)) - Date.now()).toBeGreaterThan(60 * 60_000);
  });

  it('is not dropped as a scam when the model scores it 80 or above', async () => {
    seam.scam.mockResolvedValue({ isScam: true, scamType: 'phishing', confidence: 95 });
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    const comm = db.table('guardian_communications').find((row) => row.twilio_sms_sid === SMS_SID);
    // The defect: status 'blocked', nothing sent, nobody told.
    expect(comm).toMatchObject({ status: 'escalated', scam_detected: true, scam_confidence: 95 });
    expect(escalations()).toHaveLength(1);
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(notifications().some((row) => String(row.title).startsWith('🚨 Emergency text from'))).toBe(true);
  });

  it('a redelivery of the same message alarms nobody twice', async () => {
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(escalations()).toHaveLength(1);
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(seam.calls).toEqual([PARENT_PHONE]);
    // One text notice and one escalation alert, each once.
    expect(notifications().filter((row) => String(row.title).startsWith('🚨 Emergency text from'))).toHaveLength(1);
    expect(notifications().filter((row) => String(row.title).startsWith('🚨 EMERGENCY'))).toHaveLength(1);
  });
});

describe('an emergency WhatsApp', () => {
  it('is announced as urgent and escalated to the managers\' phones', async () => {
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    const res = await POST(signed('/api/guardian/inbound/whatsapp', { SmsSid: SMS_SID, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: EMERGENCY }));
    expect(res.status).toBe(200);
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ urgent: true, title: expect.stringMatching(/^🚨 Emergency WhatsApp from/) });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(db.table('guardian_communications')[0]).toMatchObject({ status: 'escalated' });
  });

  it('a routine WhatsApp is neither urgent nor escalated (positive control)', async () => {
    const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
    expect((await POST(signed('/api/guardian/inbound/whatsapp', { SmsSid: OTHER_SID, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: ROUTINE }))).status).toBe(200);
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.notify.mock.calls[0][1]).not.toHaveProperty('urgent');
    expect(escalations()).toEqual([]);
    expect(seam.sms).toEqual([]);
  });
});

describe('a screened call the AI classifies as an emergency', () => {
  const EMERGENCY_TURN = {
    responseText: 'Stay on the line.',
    decision: { action: 'voicemail', risk: 'safe', urgency: 'emergency', intent: 'personal', summary: 'Caller says grandpa collapsed.', callerName: 'Neighbour' },
  };

  it('answers Twilio before the managers are texted and called, and still reaches them once the TwiML is out', async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue(EMERGENCY_TURN);
    // A request scope: Next holds the task until the response has been sent.
    const held: Array<() => Promise<void>> = [];
    seam.after.mockImplementation((task: () => Promise<void>) => { held.push(task); });
    const { POST } = await import('@/app/api/guardian/screen/route');
    const res = await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Grandpa collapsed, please hurry.' }, `?sessionId=${SESSION}&turn=1`));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<Record/);
    // The defect: Twilio's 15-second clock ran through two Twilio requests per
    // manager before the TwiML went out. Now the TwiML is out first, with the
    // in-app row already written, and nothing has reached a phone yet.
    expect(held).toHaveLength(1);
    expect(notifications().some((row) => String(row.title).startsWith('🚨 Emergency call from'))).toBe(true);
    expect(seam.sms).toEqual([]);
    expect(seam.calls).toEqual([]);
    expect(escalations()).toEqual([]);
    await held[0]();
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ escalation_type: 'emergency_call', communication_id: COMM, notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(seam.calls).toEqual([PARENT_PHONE]);
  });

  it('escalates to the managers\' phones instead of only writing an in-app row (inline, outside a request scope)', async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue(EMERGENCY_TURN);
    const { POST } = await import('@/app/api/guardian/screen/route');
    const res = await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Grandpa collapsed, please hurry.' }, `?sessionId=${SESSION}&turn=1`));
    expect(res.status).toBe(200);
    // `after()` threw (no request scope), so the escalation ran before the response.
    expect(seam.after).toHaveBeenCalledOnce();
    // The defect: an in-app notification with user_id null, and nothing else.
    expect(notifications().some((row) => String(row.title).startsWith('🚨 Emergency call from'))).toBe(true);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ escalation_type: 'emergency_call', severity: 'critical', communication_id: COMM, notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sms).toEqual([PARENT_PHONE]);
    expect(seam.calls).toEqual([PARENT_PHONE]);
  });

  it('a medium-urgency screened call does not (positive control)', async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue({ responseText: 'Thanks.', decision: { action: 'voicemail', risk: 'safe', urgency: 'medium', intent: 'personal', summary: 'Grandma calling.', callerName: 'Grandma' } });
    const { POST } = await import('@/app/api/guardian/screen/route');
    expect((await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Hi, it is Grandma.' }, `?sessionId=${SESSION}&turn=1`))).status).toBe(200);
    expect(escalations()).toEqual([]);
    expect(seam.sms).toEqual([]);
  });
});
