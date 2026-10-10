// An outsider who knows a Guardian number must not be able to buy model calls.
//
// Every signed inbound SMS and WhatsApp ran detectScamWithAI (an Anthropic /
// OpenAI request) even when the pipeline had just answered `blocked` for the
// sender, and nothing in lib/guardian or app/api/guardian rate-limited anyone.
// A blocked or spamming sender could drive unbounded spend, and every
// non-blocked message produced a family notification.
//
// Now: no model call where the answer cannot change anything (the sender is
// blocked, or the pattern detector is already sure), and none past a rolling
// per-sender / per-family cap — past it the message is still kept in the inbox,
// recorded as blocked with the reason, and the family is not pinged. The
// decision is durable: a redelivery of a capped message completes against the
// saved `blocked` rather than recounting the window.
//
// The per-sender cap holds only a sender the family has not vouched for. A
// contact at a ring-through trust level (immediate family, close family,
// trusted friend) is who the number exists to let through: past the cap they
// lose the model call, never the delivery. The family-wide cap holds for all.
//
// And the cap is a HARD cap on model spend. A count that cannot be read used
// to read as zero (fail-open), so a slow or refused count bought the model
// call; now an unreadable count withholds the model call and nothing else —
// the message is still recorded and delivered. The WhatsApp lane also counted
// BEFORE it recorded the message, so concurrent distinct deliveries at one
// under the cap all read "under" and all bought a model call; it now records
// first and counts second, as the SMS lane always did, and a message it could
// not record (and so cannot count) buys no model call either.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';
import { GUARDIAN_INBOUND_FAMILY_CAP, GUARDIAN_INBOUND_SENDER_CAP } from '@/lib/guardian/inbound-caps';

const seam = vi.hoisted(() => ({ service: vi.fn(), pipeline: vi.fn(), scam: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(), isTwilioConfigured: () => false, sendSms: async () => {}, initiateCall: async () => {},
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const GUARDIAN = '+15555550100';
const SENDER = '+15555550199';
const OTHER = '+15555550188';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const VOUCHED = ['immediate_family', 'close_family', 'trusted_friend'] as const;

const routine = (overrides: Record<string, unknown> = {}) => ({
  contactId: null, contactName: null, trustLevel: 'unknown', routingMode: 'voicemail_first', spamScore: 0, scamDetected: false, scamType: null,
  ruleId: null, reason: 'No rules matched', shouldEscalate: false, emergencyKeywords: false, memberProfile: null, ...overrides,
});
/** The pipeline's answer for a sender who is a saved contact at a ring-through trust level. */
const vouched = (trustLevel: string, contactName = 'Grandma') =>
  routine({ trustLevel, routingMode: 'immediate_ring', contactId: CONTACT, contactName, reason: `${contactName} rings through.` });

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const sid = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Earlier messages this hour, as the inbox has them. */
function priorMessages(count: number, from: string, commType: 'sms_inbound' | 'whatsapp_inbound', firstSid = 1000) {
  db.seed('guardian_communications', Array.from({ length: count }, (_, i) => ({
    id: `aaaaaaaa-0000-4000-8000-${(firstSid + i).toString(16).padStart(12, '0')}`, family_id: FAMILY, member_id: MEMBER, comm_type: commType, direction: 'inbound',
    from_number: from, to_number: GUARDIAN, body: `message ${i}`, twilio_sms_sid: sid(firstSid + i), status: 'received', started_at: minutesAgo(5 + (i % 50)),
    contact_id: null, from_name: null, trust_level_at_time: 'unknown', routing_mode_used: 'voicemail_first', routing_rule_id: null,
    ai_decision_reason: 'No rules matched', scam_detected: false, scam_type: null, scam_confidence: 0,
  })));
}

async function sms(smsSid: string, from: string, body = 'Dentist appointment tomorrow') {
  const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');
  return receiveGuardianSms(client(), { smsSid, from, to: GUARDIAN, body });
}

async function whatsapp(smsSid: string, from: string, body = 'hello?') {
  const url = `${ORIGIN}/api/guardian/inbound/whatsapp`;
  const form: Record<string, string> = { SmsSid: smsSid, From: `whatsapp:${from}`, To: `whatsapp:${GUARDIAN}`, Body: body };
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  const { POST } = await import('@/app/api/guardian/inbound/whatsapp/route');
  return POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: new URLSearchParams(form).toString() }));
}

const commFor = (smsSid: string) => db.table('guardian_communications').find((row) => row.twilio_sms_sid === smsSid);

/**
 * The inbox table answers every COUNT with a resolved error (a statement
 * timeout, as PostgREST reports it) while every other read and write still
 * works — the shape of a slow count under load.
 */
function refuseCounts(client: InMemorySupabase): void {
  const before = client.from.bind(client);
  const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((table: string) => {
    const query = before(table);
    if (table !== 'guardian_communications') return query;
    const realSelect = query.select.bind(query);
    query.select = ((list?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) =>
      (opts?.head ? chain : realSelect(list, opts))) as typeof query.select;
    return query;
  }) as InMemorySupabase['from'];
}

/**
 * The tables as the migrations declare them: guardian_communications.started_at
 * defaults to now(), which is what the hourly window counts. The in-memory
 * client's defaults are static values, so the clock default is added at insert time.
 */
function database(): InMemorySupabase {
  const fresh = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], ai_tool_calls: [['id']], guardian_communications: [['twilio_sms_sid']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  const realFrom = fresh.from.bind(fresh);
  fresh.from = ((table: string) => {
    const query = realFrom(table);
    if (table !== 'guardian_communications') return query;
    const realInsert = query.insert.bind(query);
    query.insert = (rows) => realInsert((Array.isArray(rows) ? rows : [rows]).map((row) => ({ started_at: new Date().toISOString(), ...row })));
    return query;
  }) as InMemorySupabase['from'];
  return fresh;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  db = database();
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, display_name: 'Kid', is_active: true, role: 'child' }]);
  db.seed('guardian_member_profiles', [{
    id: PROFILE, family_id: FAMILY, member_id: MEMBER, guardian_phone: GUARDIAN, is_active: true, default_mode_suspected_spam: 'silent_handling',
    default_mode_blocked: 'blocked', default_mode_unknown: 'voicemail_first',
  }]);
  seam.service.mockImplementation(() => db);
  seam.pipeline.mockReset(); seam.scam.mockReset(); seam.notify.mockReset();
  seam.pipeline.mockResolvedValue(routine());
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('an inbound SMS', () => {
  it('from a blocked sender is recorded and completed without a model call or a notification', async () => {
    seam.pipeline.mockResolvedValue(routine({ trustLevel: 'blocked', routingMode: 'blocked', reason: 'Blocked contact' }));
    expect(await sms(sid(1), SENDER)).toBe('completed');
    // The defect: one LLM request per text from a sender the family had blocked.
    expect(seam.scam).not.toHaveBeenCalled();
    expect(commFor(sid(1))).toMatchObject({ routing_mode_used: 'blocked', trust_level_at_time: 'blocked' });
    expect(db.table('notifications')).toEqual([]);
  });

  it('the pattern detector being sure is also the end of the question', async () => {
    seam.pipeline.mockResolvedValue(routine({ scamDetected: true, spamScore: 92, scamType: 'irs_scam', routingMode: 'silent_handling' }));
    expect(await sms(sid(2), SENDER)).toBe('completed');
    expect(seam.scam).not.toHaveBeenCalled();
    expect(commFor(sid(2))).toMatchObject({ status: 'blocked', scam_detected: true, scam_confidence: 92, scam_type: 'irs_scam' });
    expect(db.table('notifications')).toEqual([]);
  });

  it('under the cap, a routine text is analysed once and announced once (positive control)', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP - 1, SENDER, 'sms_inbound');
    expect(await sms(sid(3), SENDER)).toBe('completed');
    expect(seam.scam).toHaveBeenCalledOnce();
    expect(commFor(sid(3))).toMatchObject({ status: 'received' });
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('notifications')[0]).toMatchObject({ title: `💬 Text from ${'(555) 555-0199'}` });
  });

  it('past the per-sender cap, the text is kept, recorded as blocked with the reason, and buys neither a model call nor a ping', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'sms_inbound');
    expect(await sms(sid(4), SENDER)).toBe('completed');
    expect(seam.scam).not.toHaveBeenCalled();
    expect(commFor(sid(4))).toMatchObject({ status: 'blocked', routing_mode_used: 'voicemail_first', body: 'Dentist appointment tomorrow' });
    expect(String(commFor(sid(4))?.ai_decision_reason)).toMatch(/hourly message cap/);
    expect(db.table('notifications')).toEqual([]);
    // A redelivery completes against the saved decision instead of asking for ever.
    expect(await sms(sid(4), SENDER)).toBe('completed');
    expect(seam.scam).not.toHaveBeenCalled();
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: sid(4), status: 'processed' })]);
  });

  it('one flooding sender does not silence another sender under the cap', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'sms_inbound');
    expect(await sms(sid(5), OTHER)).toBe('completed');
    expect(seam.scam).toHaveBeenCalledOnce();
    expect(commFor(sid(5))).toMatchObject({ status: 'received' });
    expect(db.table('notifications')).toHaveLength(1);
  });

  it('the whole family has a cap too', async () => {
    // Many senders, each under their own cap, together past the family's.
    for (let i = 0; i < GUARDIAN_INBOUND_FAMILY_CAP / 5; i += 1) priorMessages(5, `+1555000${String(i).padStart(4, '0')}`, 'sms_inbound', 2000 + i * 5);
    expect(await sms(sid(6), OTHER)).toBe('completed');
    expect(seam.scam).not.toHaveBeenCalled();
    expect(commFor(sid(6))).toMatchObject({ status: 'blocked' });
    expect(db.table('notifications')).toEqual([]);
  });

  describe('from a contact the family vouched for', () => {
    beforeEach(() => db.seed('guardian_contacts', [{ id: CONTACT, family_id: FAMILY, phone: SENDER, name: 'Grandma', trust_level: 'immediate_family' }]));

    it.each(VOUCHED)('the eleventh text in an hour from %s is still announced; only the model call is capped', async (trustLevel) => {
      priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'sms_inbound');
      seam.pipeline.mockResolvedValue(vouched(trustLevel));
      expect(await sms(sid(8), SENDER)).toBe('completed');
      // The defect: written `blocked` with the cap reason, and never announced.
      expect(commFor(sid(8))).toMatchObject({ status: 'received', trust_level_at_time: trustLevel, contact_id: CONTACT, from_name: 'Grandma', body: 'Dentist appointment tomorrow' });
      expect(String(commFor(sid(8))?.ai_decision_reason)).not.toMatch(/hourly message cap/);
      expect(db.table('notifications')).toHaveLength(1);
      expect(db.table('notifications')[0]).toMatchObject({ title: '💬 Text from Grandma' });
      // Model spend stays bounded whoever is texting.
      expect(seam.scam).not.toHaveBeenCalled();
      // A redelivery completes against the saved `received`, announcing nobody twice.
      expect(await sms(sid(8), SENDER)).toBe('completed');
      expect(commFor(sid(8))).toMatchObject({ status: 'received' });
      expect(db.table('notifications')).toHaveLength(1);
      expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: sid(8), status: 'processed' })]);
    });

    it('a saved contact who is only known, not vouched for, is still held past the cap', async () => {
      priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'sms_inbound');
      seam.pipeline.mockResolvedValue(routine({ trustLevel: 'known_contact', routingMode: 'ai_handle_first', contactId: CONTACT, contactName: 'Plumber' }));
      expect(await sms(sid(9), SENDER)).toBe('completed');
      expect(seam.scam).not.toHaveBeenCalled();
      expect(commFor(sid(9))).toMatchObject({ status: 'blocked', trust_level_at_time: 'known_contact' });
      expect(String(commFor(sid(9))?.ai_decision_reason)).toMatch(/hourly message cap/);
      expect(db.table('notifications')).toEqual([]);
    });

    it('the family cap still holds for them', async () => {
      for (let i = 0; i < GUARDIAN_INBOUND_FAMILY_CAP / 5; i += 1) priorMessages(5, `+1555000${String(i).padStart(4, '0')}`, 'sms_inbound', 2000 + i * 5);
      seam.pipeline.mockResolvedValue(vouched('immediate_family'));
      expect(await sms(sid(10), SENDER)).toBe('completed');
      expect(seam.scam).not.toHaveBeenCalled();
      expect(commFor(sid(10))).toMatchObject({ status: 'blocked', trust_level_at_time: 'immediate_family' });
      expect(String(commFor(sid(10))?.ai_decision_reason)).toMatch(/hourly message cap/);
      expect(db.table('notifications')).toEqual([]);
    });
  });

  it('counts only this hour', async () => {
    db.seed('guardian_communications', Array.from({ length: GUARDIAN_INBOUND_SENDER_CAP + 5 }, (_, i) => ({
      id: `bbbbbbbb-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, family_id: FAMILY, member_id: MEMBER, comm_type: 'sms_inbound', direction: 'inbound',
      from_number: SENDER, to_number: GUARDIAN, body: 'old', twilio_sms_sid: sid(3000 + i), status: 'received', started_at: minutesAgo(90 + i),
    })));
    expect(await sms(sid(7), SENDER)).toBe('completed');
    expect(seam.scam).toHaveBeenCalledOnce();
    expect(commFor(sid(7))).toMatchObject({ status: 'received' });
  });
});

describe('an inbound WhatsApp', () => {
  it('from a blocked sender makes no model call', async () => {
    seam.pipeline.mockResolvedValue(routine({ trustLevel: 'blocked', routingMode: 'blocked', reason: 'Blocked contact' }));
    expect((await whatsapp(sid(11), SENDER)).status).toBe(200);
    expect(seam.scam).not.toHaveBeenCalled();
    expect(seam.notify).not.toHaveBeenCalled();
    expect(commFor(sid(11))).toMatchObject({ routing_mode_used: 'blocked', trust_level_at_time: 'blocked' });
  });

  it('past the per-sender cap is kept as blocked with the reason, with no model call and no ping', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'whatsapp_inbound');
    expect((await whatsapp(sid(12), SENDER)).status).toBe(200);
    expect(seam.scam).not.toHaveBeenCalled();
    expect(seam.notify).not.toHaveBeenCalled();
    expect(commFor(sid(12))).toMatchObject({ status: 'blocked', body: 'hello?' });
    expect(String(commFor(sid(12))?.ai_decision_reason)).toMatch(/hourly message cap/);
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: sid(12), status: 'processed' })]);
  });

  it('under the cap is analysed and announced (positive control)', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP - 1, SENDER, 'whatsapp_inbound');
    expect((await whatsapp(sid(13), SENDER)).status).toBe(200);
    expect(seam.scam).toHaveBeenCalledOnce();
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(commFor(sid(13))).toMatchObject({ status: 'received' });
  });

  describe('from a contact the family vouched for', () => {
    beforeEach(() => db.seed('guardian_contacts', [{ id: CONTACT, family_id: FAMILY, phone: SENDER, name: 'Grandma', trust_level: 'close_family' }]));

    it.each(VOUCHED)('the eleventh in an hour from %s is still announced; only the model call is capped', async (trustLevel) => {
      priorMessages(GUARDIAN_INBOUND_SENDER_CAP, SENDER, 'whatsapp_inbound');
      seam.pipeline.mockResolvedValue(vouched(trustLevel));
      expect((await whatsapp(sid(14), SENDER)).status).toBe(200);
      expect(seam.scam).not.toHaveBeenCalled();
      // The defect: recorded `blocked`, and the family never told.
      expect(seam.notify).toHaveBeenCalledOnce();
      expect(seam.notify.mock.calls[0][1]).toMatchObject({ title: '💚 WhatsApp from Grandma', body: 'hello?' });
      expect(commFor(sid(14))).toMatchObject({ status: 'received', trust_level_at_time: trustLevel, contact_id: CONTACT });
      expect(String(commFor(sid(14))?.ai_decision_reason)).not.toMatch(/hourly message cap/);
    });

    it('the family cap still holds for them', async () => {
      for (let i = 0; i < GUARDIAN_INBOUND_FAMILY_CAP / 5; i += 1) priorMessages(5, `+1555000${String(i).padStart(4, '0')}`, 'whatsapp_inbound', 2000 + i * 5);
      seam.pipeline.mockResolvedValue(vouched('immediate_family'));
      expect((await whatsapp(sid(15), SENDER)).status).toBe(200);
      expect(seam.scam).not.toHaveBeenCalled();
      expect(seam.notify).not.toHaveBeenCalled();
      expect(commFor(sid(15))).toMatchObject({ status: 'blocked', trust_level_at_time: 'immediate_family' });
      expect(String(commFor(sid(15))?.ai_decision_reason)).toMatch(/hourly message cap/);
    });
  });
});

describe('the cap is a hard cap on model spend', () => {
  it('concurrent WhatsApp deliveries at one under the cap buy at most one model call between them', async () => {
    priorMessages(GUARDIAN_INBOUND_SENDER_CAP - 1, SENDER, 'whatsapp_inbound');
    const sids = [sid(20), sid(21), sid(22)];
    const responses = await Promise.all(sids.map((smsSid) => whatsapp(smsSid, SENDER)));
    for (const res of responses) expect(res.status).toBe(200);
    // The defect: the lane counted before it recorded, so all three read
    // "nine this hour" and all three bought a model call.
    expect(seam.scam.mock.calls.length).toBeLessThanOrEqual(1);
    // Every message is still recorded, and each is processed to a decision.
    for (const smsSid of sids) expect(commFor(smsSid)).toMatchObject({ body: 'hello?', status: expect.stringMatching(/^(received|blocked)$/) });
    expect(db.table('guardian_callback_events').filter((row) => row.status === 'processed')).toHaveLength(3);
  });

  it('an inbound SMS whose cap count cannot be read is recorded and announced without a model call', async () => {
    refuseCounts(db);
    expect(await sms(sid(30), SENDER)).toBe('completed');
    // The defect: the unreadable count read as zero, and the model was asked.
    expect(seam.scam).not.toHaveBeenCalled();
    // Only the model call is withheld: the message is kept and the family told.
    expect(commFor(sid(30))).toMatchObject({ status: 'received', body: 'Dentist appointment tomorrow' });
    expect(String(commFor(sid(30))?.ai_decision_reason)).not.toMatch(/hourly message cap/);
    expect(db.table('notifications')).toHaveLength(1);
  });

  it('an inbound WhatsApp whose cap count cannot be read is recorded and announced without a model call', async () => {
    refuseCounts(db);
    expect((await whatsapp(sid(31), SENDER)).status).toBe(200);
    expect(seam.scam).not.toHaveBeenCalled();
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(commFor(sid(31))).toMatchObject({ status: 'received', body: 'hello?' });
    expect(String(commFor(sid(31))?.ai_decision_reason)).not.toMatch(/hourly message cap/);
  });

  it('an inbound WhatsApp that could not be recorded cannot be counted, and buys no model call either', async () => {
    // The row this delivery would write already exists (twilio_sms_sid is
    // unique), so the insert is refused and the message goes on unlogged.
    db.seed('guardian_communications', [{ id: `cccccccc-0000-4000-8000-${'0'.repeat(12)}`, family_id: FAMILY, member_id: MEMBER, comm_type: 'whatsapp_inbound', direction: 'inbound',
      from_number: OTHER, to_number: GUARDIAN, body: 'an earlier delivery', twilio_sms_sid: sid(32), status: 'received', started_at: minutesAgo(1) }]);
    expect((await whatsapp(sid(32), SENDER)).status).toBe(200);
    // The defect: counted before recording, so the failed record was invisible
    // to the cap and the model was asked for a message the ledger never saw.
    expect(seam.scam).not.toHaveBeenCalled();
    // Still delivered, as the route has always promised for a failed record.
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ event_id: sid(32), status: 'processed' })]);
  });

  it('the WhatsApp lane records before it counts, like the SMS lane', () => {
    const source = readFileSync('app/api/guardian/inbound/whatsapp/route.ts', 'utf8');
    expect(at(source, "from('guardian_communications').insert(")).toBeLessThan(at(source, 'await overInboundCap('));
    expect(at(source, 'await overInboundCap(')).toBeLessThan(at(source, 'await detectScamWithAI('));
  });
});
