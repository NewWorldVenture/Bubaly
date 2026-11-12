// The urgent contact-centre cron, driven as the scheduler drives it: the real
// exported GET, the real `hasCronAuthorization` against a stubbed CRON_SECRET,
// and the real drain (lib/contact-center/urgent-delivery.ts) over an in-memory
// database seeded with several households.
//
// Faked: the database (tests/helpers/in-memory-supabase.ts), translations (the
// key, with its variables, so a sent body can be traced to its family), the
// clock (Date only) and the SMS provider at the seam the repository's other
// urgent-delivery tests stub (`@/lib/guardian/twilio`). Nothing leaves the
// process.
//
// What tests/contact-center-urgent-execution.test.ts already proves is not
// repeated: the receipt state machine one message at a time, the cursor and
// wrap, a missing Authorization header, and the 503-then-200 provider
// recovery. This file adds the request-level run across households.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { captureInboundWithUrgency } from '@/lib/contact-center/urgent-delivery';

const mocks = vi.hoisted(() => ({ send: vi.fn(), configured: vi.fn(), client: { current: null as unknown }, service: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: mocks.configured, sendSmsWithReceipt: mocks.send }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
}));

const { GET } = await import('@/app/api/cron/contact-center-urgent/route');

const SECRET = 'test-cron-secret-not-real';
const TOOL = 'contact_center.urgent_delivery';
const SID_A = `SM${'a'.repeat(32)}`;
const SID_B = `SM${'b'.repeat(32)}`;

const FAMILY_A = '00000000-0000-4000-8000-0000000000a1';
const FAMILY_B = '00000000-0000-4000-8000-0000000000b1';
const FAMILY_CLOSED = '00000000-0000-4000-8000-0000000000c1';
const FAMILY_IN_APP = '00000000-0000-4000-8000-0000000000d1';

const LINE = { [FAMILY_A]: '+15555550101', [FAMILY_B]: '+15555550102', [FAMILY_CLOSED]: '+15555550103', [FAMILY_IN_APP]: '+15555550104' };
const FORWARD = { [FAMILY_A]: '+15555550201', [FAMILY_B]: '+15555550202', [FAMILY_CLOSED]: '+15555550203' };
const SENDER = { [FAMILY_A]: '+15555550301', [FAMILY_B]: '+15555550302', [FAMILY_CLOSED]: '+15555550303', [FAMILY_IN_APP]: '+15555550304' };
const SUMMARY = {
  [FAMILY_A]: 'Alpha household: school called about pickup',
  [FAMILY_B]: 'Bravo household: pharmacy needs a callback',
  [FAMILY_CLOSED]: 'Closed household: should never be texted',
  [FAMILY_IN_APP]: 'Delta household: no forwarding phone set',
};

let db: InMemorySupabase;

function freshDb(): InMemorySupabase {
  return createInMemorySupabase({
    uniques: { ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], notifications: [['id']], family_inbox_messages: [['channel', 'provider_ref']], app_settings: [['key']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound' }, notifications: { is_read: false, sent_at: null, pushed_at: null } },
  });
}
const admin = () => db as unknown as Parameters<typeof captureInboundWithUrgency>[0];
const useClient = (client: unknown) => { mocks.client.current = client; };

function request(authorization: string | null) {
  return new NextRequest('https://bubaly.test/api/cron/contact-center-urgent', authorization === null ? {} : { headers: { authorization } });
}
async function call(authorization: string | null = `Bearer ${SECRET}`) {
  const res = await GET(request(authorization));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function tick(ms: number) { vi.setSystemTime(new Date(Date.now() + ms)); }
async function capture(familyId: string, ref: string) {
  tick(1000);
  return captureInboundWithUrgency(admin(), {
    familyId, channel: 'sms', providerRef: ref, from: SENDER[familyId as keyof typeof SENDER],
    to: LINE[familyId as keyof typeof LINE], body: SUMMARY[familyId as keyof typeof SUMMARY], aiSummary: SUMMARY[familyId as keyof typeof SUMMARY], aiIntent: 'urgent',
  });
}
const receiptOf = (familyId: string) => db.table('ai_tool_calls').filter((r) => r.family_id === familyId && r.tool_name === TOOL);
const notificationsOf = (familyId: string) => db.table('notifications').filter((r) => r.family_id === familyId);
const sentTo = () => mocks.send.mock.calls.map(([to]) => to as string);

/**
 * Four households: A and B open with a forwarding phone (texted), D open with
 * none (in-app only), C closed (families.closed_at, left alone). A also holds
 * one receipt that an earlier run already delivered.
 */
async function seedHouseholds() {
  db.seed('families', [
    { id: FAMILY_A, closed_at: null }, { id: FAMILY_B, closed_at: null },
    { id: FAMILY_CLOSED, closed_at: '2026-10-01T00:00:00.000Z' }, { id: FAMILY_IN_APP, closed_at: null },
  ]);
  db.seed('family_contact_channels', [
    { family_id: FAMILY_A, phone_number: LINE[FAMILY_A], forward_to_phone: FORWARD[FAMILY_A] },
    { family_id: FAMILY_B, phone_number: LINE[FAMILY_B], forward_to_phone: FORWARD[FAMILY_B] },
    { family_id: FAMILY_CLOSED, phone_number: LINE[FAMILY_CLOSED], forward_to_phone: FORWARD[FAMILY_CLOSED] },
    { family_id: FAMILY_IN_APP, phone_number: LINE[FAMILY_IN_APP], forward_to_phone: null },
  ]);
  const handled = await capture(FAMILY_A, 'sms-a-already-delivered');
  const done = db.table('ai_tool_calls').find((r) => r.id === handled.urgentReceiptId)!;
  done.state = 'succeeded';
  done.outputs = { ...(done.outputs as object), phase: 'accepted', notificationDone: true, drain: false, providerSid: SID_A, providerStatus: 'queued' };
  const a = await capture(FAMILY_A, 'sms-a-new');
  const closed = await capture(FAMILY_CLOSED, 'sms-c-new');
  const b = await capture(FAMILY_B, 'sms-b-new');
  const inApp = await capture(FAMILY_IN_APP, 'sms-d-new');
  return { handled: handled.urgentReceiptId!, a: a.urgentReceiptId!, closed: closed.urgentReceiptId!, b: b.urgentReceiptId!, inApp: inApp.urgentReceiptId! };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T01:00:00.000Z'));
  vi.stubEnv('CRON_SECRET', SECRET);
  db = freshDb();
  useClient(db);
  mocks.service.mockReset();
  mocks.service.mockImplementation(() => mocks.client.current);
  mocks.configured.mockReset();
  mocks.configured.mockReturnValue(true);
  mocks.send.mockReset();
  mocks.send.mockImplementation(async (to: string) => ({ kind: 'accepted', messageSid: to === FORWARD[FAMILY_B] ? SID_B : SID_A, providerStatus: 'queued' }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('authorization comes before any read', () => {
  const refused: [string, string | null][] = [
    ['no Authorization header', null],
    ['a wrong secret', 'Bearer not-the-cron-secret'],
    ['the right secret without the Bearer scheme', SECRET],
  ];
  for (const [label, header] of refused) {
    it(`API-62F6F32B2748 JOB-47B3E5312926: ${label} answers 401 and touches nothing`, async () => {
      await seedHouseholds();
      const before = db.log.length;
      const res = await call(header);
      expect(res).toEqual({ status: 401, body: { ok: false } });
      expect(mocks.service).not.toHaveBeenCalled();
      expect(db.log.length).toBe(before);
      expect(mocks.configured).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(db.table('notifications')).toEqual([]);
    });
  }

  it('API-62F6F32B2748 JOB-47B3E5312926: the right secret is admitted and reads the queue', async () => {
    const res = await call();
    expect(res).toEqual({ status: 200, body: { ok: true, examined: 0, accepted: 0, in_app_only: 0, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 } });
    expect(mocks.service).toHaveBeenCalledOnce();
    expect(db.log.map((entry) => entry.table)).toContain('ai_tool_calls');
  });
});

describe('a populated run over several households', () => {
  it('API-62F6F32B2748 JOB-47B3E5312926: texts the two open households with a forwarding phone, alerts the in-app one, and leaves the closed and the handled alone', async () => {
    const ids = await seedHouseholds();
    const res = await call();

    expect(res).toEqual({ status: 200, body: { ok: true, examined: 3, accepted: 2, in_app_only: 1, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 } });
    expect([...sentTo()].sort()).toEqual([FORWARD[FAMILY_A], FORWARD[FAMILY_B]].sort());

    const byId = (id: string) => db.table('ai_tool_calls').find((r) => r.id === id)!;
    expect(byId(ids.a)).toMatchObject({ state: 'succeeded', attempt: 1, outputs: { phase: 'accepted', drain: false, providerSid: SID_A, destination: FORWARD[FAMILY_A] } });
    expect(byId(ids.b)).toMatchObject({ state: 'succeeded', attempt: 1, outputs: { phase: 'accepted', drain: false, providerSid: SID_B, destination: FORWARD[FAMILY_B] } });
    expect(byId(ids.inApp)).toMatchObject({ state: 'succeeded', attempt: 0, outputs: { phase: 'in_app_only', drain: false, destination: null } });
    // Closed: still queued, never attempted, no alert, no text.
    expect(byId(ids.closed)).toMatchObject({ state: 'reserved', attempt: 0, outputs: { phase: 'queued', drain: true, notificationDone: false } });
    expect(notificationsOf(FAMILY_CLOSED)).toEqual([]);
    expect(sentTo()).not.toContain(FORWARD[FAMILY_CLOSED]);
    // Already handled: not re-sent, not re-alerted.
    expect(byId(ids.handled)).toMatchObject({ state: 'succeeded', attempt: 0, outputs: { phase: 'accepted', drain: false } });
    expect(notificationsOf(FAMILY_A)).toHaveLength(1);

    expect(notificationsOf(FAMILY_B)).toHaveLength(1);
    expect(notificationsOf(FAMILY_IN_APP)).toHaveLength(1);
    expect(db.table('app_settings').map((r) => r.key)).toEqual([`${TOOL}:cursor`]);
  });

  it('API-62F6F32B2748 JOB-47B3E5312926: nothing derived from one household reaches another', async () => {
    await seedHouseholds();
    await call();

    for (const family of [FAMILY_A, FAMILY_B]) {
      const texts = mocks.send.mock.calls.filter(([to]) => to === FORWARD[family as keyof typeof FORWARD]);
      expect(texts).toHaveLength(1);
      expect(String(texts[0][1])).toContain(SUMMARY[family as keyof typeof SUMMARY]);
      for (const other of Object.keys(SUMMARY).filter((f) => f !== family)) {
        expect(String(texts[0][1])).not.toContain(SUMMARY[other as keyof typeof SUMMARY]);
      }
    }
    for (const notification of db.table('notifications')) {
      const message = db.table('family_inbox_messages').find((m) => m.id === notification.related_id)!;
      expect(message.family_id).toBe(notification.family_id);
      expect(notification).toMatchObject({ user_id: null, related_type: 'contact_center', body: SUMMARY[notification.family_id as keyof typeof SUMMARY] });
    }
    expect(new Set(db.table('notifications').map((n) => n.family_id))).toEqual(new Set([FAMILY_A, FAMILY_B, FAMILY_IN_APP]));
  });
});

describe('a second run, and runs that fail part way', () => {
  it('API-62F6F32B2748 JOB-47B3E5312926: a second run sends nothing and writes no new alert', async () => {
    await seedHouseholds();
    expect((await call()).status).toBe(200);
    const notifications = db.table('notifications').length;
    const receipts = JSON.stringify(db.table('ai_tool_calls'));
    tick(60_000);

    const again = await call();
    expect(again).toEqual({ status: 200, body: { ok: true, examined: 0, accepted: 0, in_app_only: 0, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 } });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(db.table('notifications')).toHaveLength(notifications);
    expect(JSON.stringify(db.table('ai_tool_calls'))).toBe(receipts);
  });

  it('API-62F6F32B2748 JOB-47B3E5312926: an unreadable queue answers 503 with a failure and sends nothing', async () => {
    await seedHouseholds();
    useClient(withFaults(db, (table, calls) => (table === 'ai_tool_calls' && calls.some((c) => c.method === 'select' && String(c.args[0]).includes('families!inner'))
      ? { code: '08006', message: 'injected: urgent queue read failed' } : null)));
    const res = await call();
    expect(res).toEqual({ status: 503, body: { ok: false, failed: 1 } });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('app_settings')).toEqual([]);
  });

  it('API-62F6F32B2748 JOB-47B3E5312926: one household\'s unreadable routing is a counted failure (503); the other is still texted, and the next run recovers it', async () => {
    const ids = await seedHouseholds();
    useClient(withFaults(db, (table, calls) => (table === 'family_contact_channels' && calls.some((c) => c.method === 'eq' && c.args[1] === FAMILY_A)
      ? { code: '08006', message: 'injected: routing read failed' } : null)));
    const res = await call();
    expect(res).toEqual({ status: 503, body: { ok: false, examined: 3, accepted: 1, in_app_only: 1, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 1 } });
    expect(sentTo()).toEqual([FORWARD[FAMILY_B]]);
    expect(db.table('ai_tool_calls').find((r) => r.id === ids.a)).toMatchObject({ attempt: 0, outputs: { phase: 'queued', drain: true } });

    useClient(db);
    tick(60_000);
    const recovered = await call();
    expect(recovered).toEqual({ status: 200, body: { ok: true, examined: 1, accepted: 1, in_app_only: 0, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 } });
    expect([...sentTo()].sort()).toEqual([FORWARD[FAMILY_A], FORWARD[FAMILY_B]].sort());
    // The in-app alert was written on the first run, before the routing read; the retry does not repeat it.
    expect(notificationsOf(FAMILY_A)).toHaveLength(1);
  });

  it('API-62F6F32B2748 JOB-47B3E5312926: a provider refusal for one household is reported pending (503), the other is accepted, and nothing is texted twice', async () => {
    const ids = await seedHouseholds();
    mocks.send.mockImplementation(async (to: string) => (to === FORWARD[FAMILY_A]
      ? { kind: 'retryable' }
      : { kind: 'accepted', messageSid: SID_B, providerStatus: 'queued' }));
    const res = await call();
    expect(res).toEqual({ status: 503, body: { ok: false, examined: 3, accepted: 1, in_app_only: 1, pending: 1, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 } });
    expect(db.table('ai_tool_calls').find((r) => r.id === ids.a)).toMatchObject({ state: 'failed', attempt: 1, outputs: { phase: 'queued', drain: true } });
    expect(db.table('ai_tool_calls').find((r) => r.id === ids.b)).toMatchObject({ state: 'succeeded', outputs: { phase: 'accepted' } });

    // Before the retry time: A is still pending and B is not texted again.
    const early = await call();
    expect(early.status).toBe(503);
    expect(early.body).toMatchObject({ ok: false, pending: 1, accepted: 0 });
    expect(sentTo().filter((to) => to === FORWARD[FAMILY_B])).toHaveLength(1);
    expect(receiptOf(FAMILY_B).filter((r) => r.state === 'succeeded')).toHaveLength(1);
  });
});
