// An emergency whose texts and calls all failed is retried until a manager is reached.
//
// escalateGuardianEmergency already answered `undelivered` when every Twilio
// request failed (a brief outage, a 5xx, a refused connection) and gave its
// claim back "so a retry can try again" — but none of the three inbound
// callers asked for one. The SMS lane logged the outcome and completed its
// receipt; the WhatsApp route logged it and marked the callback processed with
// a 200; the screening route's after() task only logged. Twilio never
// redelivers a 200, the recovery cron sweeps only receipts still `captured` or
// `decided`, and no cron or queue re-reads guardian_escalations. So after a
// transient total transport failure the SMS-and-call alert for a critical
// emergency was permanently abandoned on all three lanes, with only an in-app
// row (delivered by the push cron, hours later at best) and an unacknowledged
// dashboard entry left behind.
//
// Now: every lane is backstopped by retryUndeliveredGuardianEscalations, run
// from the guardian-sms-recovery cron: it re-attempts every recent
// unacknowledged escalation whose record says nobody was reached. Stable ids
// and the escalation's own claim keep each retry from texting twice, and a
// partial success (one manager reached) is `delivered`, so it is never re-sent.
// The SMS lane completes a message whose escalation is on record as
// undelivered and leaves the retry to that sweep (a 503 instead made the whole
// lane re-run every five minutes with no end, since the receipt drain has no
// deadline of its own); the WhatsApp route parks its callback as `error` and
// answers 503, which its claim bounds to ten minutes. And when there was nobody
// to text or call at all — no manager with a phone on file, or Twilio not
// configured — the escalation is `unreachable`: recorded with
// notified_member_ids NULL, its claim processed, the message complete, and
// nothing retries it, because trying again would find the same.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { guardianEscalationEventId, type GuardianEscalationInput } from '@/lib/guardian/escalation';

const seam = vi.hoisted(() => ({
  service: vi.fn(), scam: vi.fn(), notify: vi.fn(), turn: vi.fn(), after: vi.fn(),
  telephony: { configured: true, down: false, failFor: new Set<string>() },
  sent: [] as string[], called: [] as string[], attempts: 0,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('next/server', async (original) => ({
  ...await original<typeof import('next/server')>(),
  after: (task: () => Promise<void>) => seam.after(task),
}));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/guardian/ai-screen', () => ({ screeningTurn: seam.turn, summarizeScreening: async () => 'Caller says grandpa collapsed.' }));
// Telephony that can be switched off and on: a send while it is down rejects
// the way a Twilio 5xx or a refused connection does; a send while it is up is
// recorded, so "sent once" can be asserted on successes rather than attempts.
// It can also be unconfigured, which is not an outage: nothing can be sent.
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => seam.telephony.configured,
  sendSms: async (to: string) => {
    seam.attempts += 1;
    if (seam.telephony.down || seam.telephony.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.sent.push(to);
  },
  initiateCall: async ({ to }: { to: string }) => {
    seam.attempts += 1;
    if (seam.telephony.down || seam.telephony.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.called.push(to);
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const ADULT = '77777777-7777-4777-8777-777777777777';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const COMM = '66666666-6666-4666-8666-666666666666';
const GUARDIAN = '+15555550100';
const CALLER = '+15555550199';
const PARENT_PHONE = '+15550000777';
const ADULT_PHONE = '+15550000778';
const EMERGENCY = 'help me, there was an accident, call 911';
const SMS_SID = `SM${'a'.repeat(32)}`;
const WA_SID = `SM${'d'.repeat(32)}`;
const CALL = `CA${'c'.repeat(32)}`;
const HOUR = 60 * 60_000;

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const escalations = () => db.table('guardian_escalations');
const callback = (eventId: string) => db.table('guardian_callback_events').find((row) => row.event_id === eventId);

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
async function whatsapp(smsSid: string, body: string) {
  const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
  return POST(signed('/api/guardian/inbound/whatsapp', { SmsSid: smsSid, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: body }));
}
async function sweep() {
  const { retryUndeliveredGuardianEscalations } = await import('@/lib/guardian/escalation-retry');
  return retryUndeliveredGuardianEscalations(client());
}

/** A second manager, so a partial success can be told from a total failure. */
function secondManager() {
  db.seed('family_members', [{ id: ADULT, family_id: FAMILY, user_id: 'u-adult', display_name: 'Bo', is_active: true, role: 'adult' }]);
  db.seed('profiles', [{ id: 'u-adult', phone: ADULT_PHONE }]);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  seam.sent.length = 0; seam.called.length = 0; seam.attempts = 0;
  seam.telephony.configured = true; seam.telephony.down = false; seam.telephony.failFor.clear();
  seam.after.mockReset();
  seam.after.mockImplementation(() => { throw new Error('`after` was called outside a request scope.'); });
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']], guardian_escalations: [['id']], guardian_communications: [['twilio_sms_sid']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null }, guardian_escalations: { acknowledged_at: null } },
  });
  // guardian_escalations.escalated_at defaults to now() in 01370; the fake's defaults are static, so the clock is added at insert time.
  const realFrom = db.from.bind(db);
  db.from = ((table: string) => {
    const query = realFrom(table);
    if (table !== 'guardian_escalations') return query;
    const realUpsert = query.upsert.bind(query);
    query.upsert = (rows, opts) => realUpsert((Array.isArray(rows) ? rows : [rows]).map((row) => ({ escalated_at: new Date().toISOString(), ...row })), opts);
    return query;
  }) as InMemorySupabase['from'];
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
  seam.service.mockImplementation(() => db);
  seam.scam.mockReset(); seam.notify.mockReset(); seam.turn.mockReset();
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** The SMS lane's receipt for a message, as the recovery drain sees it. */
const receiptPhase = () => (db.table('ai_tool_calls').find((row) => row.tool_name === 'guardian.sms_intake')?.outputs as { phase: string }).phase;
/** The escalation's own claim, keyed on the communication the lane recorded. */
const escalationClaim = () => callback(guardianEscalationEventId({ familyId: FAMILY, commId: db.table('guardian_communications')[0].id as string, escalationType: 'urgent_personal', severity: 'critical', description: '' }));
const emergencyNotices = () => db.table('notifications').filter((row) => String(row.title).startsWith('🚨 EMERGENCY'));
/** The one manager has no number on file, as onboarding allows and profiles.phone is nullable. */
const parentHasNoPhone = () => db.replace('profiles', [{ id: 'u-parent', phone: null }, { id: 'u-child', phone: '+15550000001' }]);
async function resume(smsSid: string) {
  const { resumeGuardianSms } = await import('@/lib/guardian/sms-processing');
  const { guardianSmsReceiptId } = await import('@/lib/guardian/sms-receipt');
  return resumeGuardianSms(client(), guardianSmsReceiptId(smsSid));
}

describe('an emergency SMS whose every text and call failed', () => {
  it('completes with the escalation on record, and the retry sweep — not the lane — reaches the manager once', async () => {
    seam.telephony.down = true;
    // The first defect: 'completed' with nothing anywhere ever retrying the
    // alert. The second, which replaced it: 'unavailable' — the lease released
    // as `error`, the receipt left `decided`, and the whole lane re-run by the
    // recovery cron every five minutes with no end, since the drain has no
    // window and no attempt cap. The record is the retry's carrier, and the
    // sweep that reads it is bounded; so the message is done here.
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false, push_sent: true });
    expect(callback(SMS_SID), 'the message is finished; its retry is the sweep').toMatchObject({ status: 'processed' });
    expect(escalationClaim(), 'the escalation gave its claim back for the sweep').toBeUndefined();
    expect(receiptPhase(), 'the receipt is where the recovery drain does not look').toBe('completed');
    expect(seam.sent).toEqual([]);

    // While telephony stays down, neither a redelivery nor the recovery lane
    // re-runs the escalation: the sweep does, and it is the one that reports
    // nobody reached.
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(await resume(SMS_SID)).toBe('completed');
    expect(seam.attempts, 'the lane sent nothing more').toBe(2);
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 0, undelivered: 1, unavailable: 0 });
    expect(escalationClaim(), 'given back again for the next pass').toBeUndefined();

    // Telephony is back; the sweep re-runs the escalation once into the same
    // record.
    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 1, undelivered: 0, unavailable: 0 });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(escalationClaim()).toMatchObject({ status: 'processed' });
    // The family notice was written once, by the first attempt, and not again.
    expect(db.table('notifications').filter((row) => String(row.title).startsWith('🚨 Emergency text from'))).toHaveLength(1);
    expect(emergencyNotices()).toHaveLength(1);

    // Nothing is left for the next sweep, and a redelivery alarms nobody twice.
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
  });

  it('the sweep stops when a manager acknowledges the escalation in the dashboard', async () => {
    seam.telephony.down = true;
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(await sweep()).toMatchObject({ examined: 1, undelivered: 1 });
    await db.from('guardian_escalations').update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'u-parent' }).eq('id', escalations()[0].id as string);
    expect(await sweep()).toMatchObject({ examined: 0 });
    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.attempts, 'one text and one call by the lane, the same by the one sweep, and no more').toBe(4);
    expect(seam.sent).toEqual([]);
  });

  it('one that reached nobody AND could not be recorded is the lane\'s own retry, since the sweep cannot find it', async () => {
    seam.telephony.down = true;
    const before = db.from.bind(db);
    const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
        return () => chain;
      },
    });
    db.from = ((name: string) => (name === 'guardian_escalations' ? chain : before(name))) as InMemorySupabase['from'];
    // Not completed: there is no record for the sweep to read, so the lease is
    // released and the receipt stays `decided` for the recovery drain.
    expect(await sms(SMS_SID, EMERGENCY)).toBe('unavailable');
    expect(callback(SMS_SID)).toMatchObject({ status: 'error', processed_at: null });
    expect(receiptPhase()).toBe('decided');
    expect(escalations()).toEqual([]);

    db.from = before;
    seam.telephony.down = false;
    expect(await resume(SMS_SID)).toBe('completed');
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(emergencyNotices(), 'the in-app row from the first attempt is reused').toHaveLength(1);
  });
});

describe('an emergency with nobody to text or call', () => {
  it('SMS: the one manager has no phone on file — completed, recorded with nobody reached, and never re-run', async () => {
    parentHasNoPhone();
    // The defect: 'unavailable' — the lease released as `error`, the receipt
    // left `decided`, and the recovery cron re-ran the whole lane (twenty-odd
    // PostgREST calls, two console.errors, a 503) every five minutes for as
    // long as the family had no phone on file, which is to say indefinitely.
    // Acknowledging the escalation stopped the sweep, but not this.
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(seam.attempts, 'nothing was sent: there was nobody to send to').toBe(0);
    expect(escalations()).toHaveLength(1);
    // NULL, not []: nobody COULD be told. The dashboard shows both as "no
    // manager reached by phone"; the sweep re-attempts only the second.
    expect(escalations()[0]).toMatchObject({ notified_member_ids: null, sms_sent: false, call_attempted: false, push_sent: true });
    expect(callback(SMS_SID)).toMatchObject({ status: 'processed' });
    expect(escalationClaim(), 'the escalation is as handled as it can be').toMatchObject({ status: 'processed' });
    expect(receiptPhase()).toBe('completed');
    // The family still hears about it in the app, once: the lane's own notice
    // and the escalation's.
    const familyNotices = () => db.table('notifications').filter((row) => String(row.title).startsWith('🚨 Emergency text from'));
    expect(familyNotices()).toHaveLength(1);
    expect(emergencyNotices()).toHaveLength(1);

    // Nothing retries it: not the sweep, not the recovery lane, not a redelivery.
    expect(await sweep()).toMatchObject({ examined: 0, undelivered: 0, unavailable: 0 });
    expect(await resume(SMS_SID)).toBe('completed');
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(seam.attempts).toBe(0);
    expect(escalations()).toHaveLength(1);
    expect(familyNotices()).toHaveLength(1);
    expect(emergencyNotices()).toHaveLength(1);

    // A phone added later is for the next emergency, not this one.
    db.replace('profiles', [{ id: 'u-parent', phone: PARENT_PHONE }, { id: 'u-child', phone: '+15550000001' }]);
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.attempts).toBe(0);
  });

  it('WhatsApp: the message is complete with a 200, not parked for a sweep that would find the same', async () => {
    parentHasNoPhone();
    const res = await whatsapp(WA_SID, EMERGENCY);
    // The defect: 503 with the callback parked as `error`, and the sweep
    // re-running the escalation every five minutes for a day.
    expect(res.status).toBe(200);
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: null, sms_sent: false, call_attempted: false });
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect((await whatsapp(WA_SID, EMERGENCY)).status).toBe(200);
    expect(db.table('guardian_communications')).toHaveLength(1);
    expect(seam.attempts).toBe(0);
  });

  it('Twilio unconfigured is the same answer, not an outage to wait out', async () => {
    seam.telephony.configured = false;
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(escalations()[0]).toMatchObject({ notified_member_ids: null, sms_sent: false, call_attempted: false });
    expect(callback(SMS_SID)).toMatchObject({ status: 'processed' });
    expect(receiptPhase()).toBe('completed');
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.attempts).toBe(0);
  });

  it('a manager without a phone beside one whose sends failed is still undelivered: there was somebody to reach', async () => {
    secondManager();
    db.replace('profiles', [{ id: 'u-parent', phone: null }, { id: 'u-adult', phone: ADULT_PHONE }, { id: 'u-child', phone: '+15550000001' }]);
    seam.telephony.down = true;
    expect(await sms(SMS_SID, EMERGENCY)).toBe('completed');
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [], sms_sent: false });
    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 1 });
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [ADULT], sms_sent: true });
    expect(seam.sent).toEqual([ADULT_PHONE]);
  });
});

describe('an emergency WhatsApp whose every text and call failed', () => {
  it('answers 503 with the callback parked, and the retry sweep reaches the manager once', async () => {
    seam.telephony.down = true;
    const res = await whatsapp(WA_SID, EMERGENCY);
    // The defect: 200, callback processed, and the escalation never retried.
    expect(res.status).toBe(503);
    expect(callback(WA_SID), 'parked, not processed: a redelivery inside ten minutes is acknowledged without a second record or ping').toMatchObject({ status: 'error', processed_at: null });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false, communication_id: db.table('guardian_communications')[0].id });
    expect(db.table('guardian_communications')).toHaveLength(1);
    expect(seam.notify).toHaveBeenCalledOnce();

    // A redelivery while it is parked is acknowledged without a second record.
    expect((await whatsapp(WA_SID, EMERGENCY)).status).toBe(200);
    expect(db.table('guardian_communications')).toHaveLength(1);
    expect(seam.notify).toHaveBeenCalledOnce();

    // Telephony is back; the sweep on the recovery cron re-runs the escalation.
    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 1, undelivered: 0, unavailable: 0 });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(db.table('notifications').filter((row) => String(row.title).startsWith('🚨 EMERGENCY')), 'the in-app row is not written twice').toHaveLength(1);

    // Nothing is left for the next sweep, and nobody is texted again.
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('a partial success is delivered, and is never re-sent', async () => {
    secondManager();
    seam.telephony.failFor.add(ADULT_PHONE);
    expect((await whatsapp(WA_SID, EMERGENCY)).status).toBe(200);
    expect(callback(WA_SID)).toMatchObject({ status: 'processed' });
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    seam.telephony.failFor.clear();
    expect(await sweep(), 'one manager was told; the record says so, so the sweep leaves it').toMatchObject({ examined: 0 });
    expect((await whatsapp(WA_SID, EMERGENCY)).status).toBe(200);
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.attempts, 'two sends to each manager on the first pass, and no more').toBe(4);
  });
});

describe('a screened call the AI classified as an emergency, whose every text and call failed', () => {
  it('is reached by the retry sweep once telephony is back, with no duplicate send', async () => {
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: CHILD, status: 'screening', from_number: CALLER }]);
    db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: CALLER, turn: 0, status: 'active', messages: [] }]);
    seam.turn.mockResolvedValue({
      responseText: 'Stay on the line.',
      decision: { action: 'voicemail', risk: 'safe', urgency: 'emergency', intent: 'personal', summary: 'Caller says grandpa collapsed.', callerName: 'Neighbour' },
    });
    const held: Array<() => Promise<void>> = [];
    seam.after.mockImplementation((task: () => Promise<void>) => { held.push(task); });
    seam.telephony.down = true;
    const { POST } = await import('@/app/api/guardian/screen/route');
    const res = await POST(signed('/api/guardian/screen', { CallSid: CALL, SpeechResult: 'Grandpa collapsed, please hurry.' }, `?sessionId=${SESSION}&turn=1`));
    expect(res.status).toBe(200);
    expect(held).toHaveLength(1);
    await held[0]();
    // The TwiML is long gone, so nothing can be asked of Twilio; the record is
    // what carries the retry.
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ escalation_type: 'emergency_call', communication_id: COMM, notified_member_ids: [] });
    expect(seam.sent).toEqual([]);

    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 1 });
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });
});

describe('the retry sweep', () => {
  /** The id the escalation writes its record under (lib/guardian/escalate.ts stableId), so a retry lands in the same row. */
  const recordId = (input: GuardianEscalationInput) => {
    const hex = createHash('sha256').update(`${guardianEscalationEventId(input)}:escalation`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const row = (description: string, overrides: Record<string, unknown> = {}) => ({
    id: recordId({ familyId: FAMILY, escalationType: 'urgent_personal', severity: 'critical', description, callerNumber: CALLER }),
    family_id: FAMILY, communication_id: null, escalation_type: 'urgent_personal', severity: 'critical',
    description, caller_number: CALLER,
    notified_member_ids: [], push_sent: true, sms_sent: false, call_attempted: false, acknowledged_at: null,
    escalated_at: new Date(Date.now() - 10 * 60_000).toISOString(), ...overrides,
  });
  const DESCRIPTION = `Emergency text from ${CALLER}: "${EMERGENCY}"`;

  it('re-attempts only recent, unacknowledged escalations that reached nobody, into the same records', async () => {
    const retryable = row(DESCRIPTION);
    db.seed('guardian_escalations', [
      retryable,
      row('acknowledged by a manager', { acknowledged_at: new Date().toISOString() }),
      row('a day old', { escalated_at: new Date(Date.now() - 25 * HOUR).toISOString() }),
      row('already reached someone', { notified_member_ids: [PARENT], sms_sent: true }),
    ]);
    const counts = await sweep();
    expect(counts).toMatchObject({ examined: 1, delivered: 1, undelivered: 0, unavailable: 0 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
    expect(seam.called).toEqual([PARENT_PHONE]);
    // The retry is keyed exactly as the lane keyed it (the description passed
    // verbatim), so it lands in the same row rather than filing a second one.
    expect(escalations()).toHaveLength(4);
    expect(escalations().find((r) => r.id === retryable.id)).toMatchObject({ notified_member_ids: [PARENT], sms_sent: true, call_attempted: true });
    for (const description of ['acknowledged by a manager', 'a day old']) {
      expect(escalations().find((r) => r.description === description)?.notified_member_ids).toEqual([]);
    }
    expect(escalations().find((r) => r.description === 'already reached someone')?.notified_member_ids).toEqual([PARENT]);
  });

  it('counts an attempt that still reaches nobody as undelivered, leaving it for the next sweep', async () => {
    db.seed('guardian_escalations', [row(DESCRIPTION)]);
    seam.telephony.down = true;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 0, undelivered: 1 });
    expect(db.table('guardian_callback_events'), 'the escalation claim is given back for the next pass').toEqual([]);
    seam.telephony.down = false;
    expect(await sweep()).toMatchObject({ examined: 1, delivered: 1 });
    expect(seam.sent).toEqual([PARENT_PHONE]);
  });

  it('leaves a record marked as having had nobody to text or call, and marks a legacy one so on its single re-run', async () => {
    // The escalation's own mark: notified_member_ids NULL. Not read at all.
    db.seed('guardian_escalations', [row('nobody to tell', { notified_member_ids: null })]);
    expect(await sweep()).toMatchObject({ examined: 0, undelivered: 0, unavailable: 0 });

    // A record written before the mark existed ([] with nobody reached) for a
    // family that has nobody with a phone: without the fix, re-run every tick
    // and counted undelivered (a 503 from the cron) for the whole window.
    const legacy = row(DESCRIPTION);
    db.seed('guardian_escalations', [legacy]);
    parentHasNoPhone();
    expect(await sweep()).toMatchObject({ examined: 1, unreachable: 1, undelivered: 0, unavailable: 0 });
    expect(escalations().find((r) => r.id === legacy.id), 'marked on the way out').toMatchObject({ notified_member_ids: null, sms_sent: false, call_attempted: false });
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: guardianEscalationEventId({ familyId: FAMILY, escalationType: 'urgent_personal', severity: 'critical', description: DESCRIPTION, callerNumber: CALLER }), status: 'processed' })]);
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(seam.attempts).toBe(0);
  });

  it('reports a ledger it cannot read rather than claiming an empty sweep', async () => {
    const before = db.from.bind(db);
    const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
    const chain: Record<string | symbol, unknown> = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
        return () => chain;
      },
    });
    db.from = ((name: string) => (name === 'guardian_escalations' ? chain : before(name))) as InMemorySupabase['from'];
    expect(await sweep()).toMatchObject({ examined: 0, unavailable: 1 });
  });

  it('runs from the Guardian recovery cron, the one Guardian job the dispatcher already fires every five minutes', () => {
    const route = readFileSync('app/api/cron/guardian-sms-recovery/route.ts', 'utf8');
    expect(route).toContain('retryUndeliveredGuardianEscalations(');
    expect(route).toMatch(/signal:\s*req\.signal/);
    expect(readFileSync('scripts/cron-dispatch.mjs', 'utf8')).toMatch(/'\/api\/cron\/guardian-sms-recovery':\s*'\*\/5 \* \* \* \*'/);
  });
});
