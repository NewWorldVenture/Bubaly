// The Guardian recovery cron, driven over HTTP with its real secret check, over
// two households' emergencies and the records it must leave alone.
//
// tests/guardian-sms-recovery-route.test.ts pins the route's answer with both
// sweeps mocked; tests/an-emergency-nobody-reached-is-retried-until-someone-is
// drives the escalation sweep as a function, one family at a time. Neither runs
// the real GET over a populated database, so neither shows which phones one
// tick reaches, for which household, and what it writes back. Here both sweeps
// (lib/guardian/sms-recovery.ts, lib/guardian/escalation-retry.ts) and the
// escalation itself run for real against the in-memory database; only the
// Twilio seam is stubbed, as the neighbouring tests stub it.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardianEscalationEventId, guardianEscalationRecordId, type GuardianEscalationInput } from '@/lib/guardian/escalation';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({
  db: null as unknown, service: vi.fn(), touched: [] as string[],
  scam: vi.fn(), failFor: new Set<string>(), sms: [] as { to: string; body: string }[], calls: [] as string[], attempts: 0,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => true,
  sendSms: async (to: string, body: string) => {
    seam.attempts += 1;
    if (seam.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.sms.push({ to, body });
  },
  initiateCall: async ({ to }: { to: string }) => {
    seam.attempts += 1;
    if (seam.failFor.has(to)) throw new Error('Twilio 503: Service Unavailable');
    seam.calls.push(to);
  },
}));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { GET } = await import('@/app/api/cron/guardian-sms-recovery/route');
const { receiveGuardianSms } = await import('@/lib/guardian/sms-processing');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-11-12T02:10:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const A = id('a1'), B = id('b1');
const A_CHILD = id('a1e4'), B_CHILD = id('b1e4');
const GUARDIAN_A = '+15555550101', GUARDIAN_B = '+15555550201';
const A_PARENT = id('a1e1'), A_TEEN = id('a1e2'), A_GONE = id('a1e3'), B_PARENT = id('b1e1'), B_ADULT = id('b1e2');
const PHONE = {
  aParent: '+15550000101', aTeen: '+15550000102', aGone: '+15550000103', bParent: '+15550000201', bAdult: '+15550000202',
};
const CALLER = '+15555550199';
const NOTHING = { examined: 0, delivered: 0, duplicate: 0, undelivered: 0, unreachable: 0, unavailable: 0, deferred: 0, recovered: 0 };
const DRAIN_EMPTY = { examined: 0, completed: 0, busy: 0, unavailable: 0 };

type Esc = { family: string; description: string; severity: 'high' | 'critical'; over?: Row };
const input = (e: Esc): GuardianEscalationInput => ({ familyId: e.family, escalationType: 'urgent_personal', severity: e.severity, description: e.description, callerNumber: CALLER });
const record = (e: Esc): Row => ({
  id: guardianEscalationRecordId(input(e)), family_id: e.family, communication_id: null, escalation_type: 'urgent_personal',
  severity: e.severity, description: e.description, caller_number: CALLER,
  notified_member_ids: [], push_sent: true, sms_sent: false, call_attempted: false, acknowledged_at: null,
  escalated_at: ago(10 * 60_000), ...e.over,
});

const E = {
  a: { family: A, severity: 'critical', description: 'Household A: grandpa fell on the stairs' } as Esc,
  b: { family: B, severity: 'high', description: 'Household B: the school called about a fever' } as Esc,
  aAcknowledged: { family: A, severity: 'critical', description: 'A acknowledged', over: { acknowledged_at: ago(60_000) } } as Esc,
  bTooOld: { family: B, severity: 'critical', description: 'B a day old', over: { escalated_at: ago(25 * HOUR) } } as Esc,
  aReached: { family: A, severity: 'critical', description: 'A already reached', over: { notified_member_ids: [A_PARENT], sms_sent: true } } as Esc,
  bUnreachable: { family: B, severity: 'critical', description: 'B nobody to call', over: { notified_member_ids: null } } as Esc,
};
const SKIPPED = [E.aAcknowledged, E.bTooOld, E.aReached, E.bUnreachable];

let db: InMemorySupabase;
const escalation = (e: Esc) => db.table('guardian_escalations').find((r) => r.id === guardianEscalationRecordId(input(e)))!;
const claim = (e: Esc) => db.table('guardian_callback_events').find((r) => r.event_id === guardianEscalationEventId(input(e)));
const smsTo = () => seam.sms.map((s) => s.to).sort();

const request = (authorization?: string) => new NextRequest('https://guardian-fixture.invalid/api/cron/guardian-sms-recovery', {
  headers: authorization === undefined ? {} : { authorization },
});
const run = async (authorization: string | undefined = `Bearer ${SECRET}`) => {
  const res = await GET(request(authorization));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

function seed() {
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], guardian_escalations: [['id']], app_settings: [['key']], ai_tool_calls: [['id']], guardian_communications: [['twilio_sms_sid']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: A, timezone: 'Europe/London', closed_at: null }, { id: B, timezone: 'America/Los_Angeles', closed_at: null }]);
  db.seed('family_members', [
    { id: A_PARENT, family_id: A, user_id: id('a110'), role: 'parent', is_active: true },
    // Not a manager: never texted for an emergency.
    { id: A_TEEN, family_id: A, user_id: id('a120'), role: 'teen', is_active: true },
    // A removed manager: never texted either.
    { id: A_GONE, family_id: A, user_id: id('a130'), role: 'adult', is_active: false },
    { id: B_PARENT, family_id: B, user_id: id('b110'), role: 'parent', is_active: true },
    { id: B_ADULT, family_id: B, user_id: id('b120'), role: 'adult', is_active: true },
    { id: A_CHILD, family_id: A, user_id: id('a140'), display_name: 'Kid A', role: 'child', is_active: true },
    { id: B_CHILD, family_id: B, user_id: id('b140'), display_name: 'Kid B', role: 'child', is_active: true },
  ]);
  db.seed('guardian_member_profiles', [[A, A_CHILD, GUARDIAN_A, id('a1f1')], [B, B_CHILD, GUARDIAN_B, id('b1f1')]].map(([family, member, phone, profile]) => ({
    id: profile, family_id: family, member_id: member, guardian_phone: phone, is_active: true,
    ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
    emergency_always_ring: true,
  })));
  db.seed('profiles', [
    { id: id('a110'), phone: PHONE.aParent }, { id: id('a120'), phone: PHONE.aTeen }, { id: id('a130'), phone: PHONE.aGone },
    { id: id('b110'), phone: PHONE.bParent }, { id: id('b120'), phone: PHONE.bAdult },
  ]);
  db.seed('notifications', []);
  db.seed('app_settings', []);
  db.seed('ai_tool_calls', []);
  db.seed('guardian_callback_events', []);
  db.seed('guardian_escalations', [record(E.a), record(E.b), ...SKIPPED.map(record)]);
}

/**
 * The receipt drain resumes from its cursor with `or(and(or(lower),or(upper)))`.
 * The in-memory fake refuses a nested or(); PostgREST ANDs two or() filters on
 * one query, so the same condition is handed to the fake as `.or(lower).or(upper)`.
 */
function splittingNestedOr<T extends object>(client: T): T {
  const split = (expression: string): [string, string] | null => {
    if (!expression.startsWith('and(or(') || !expression.endsWith('))')) return null;
    const body = expression.slice(4, -1);
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '(') depth += 1;
      if (body[i] === ')') depth -= 1;
      if (depth === 0 && body[i] === ',') return [body.slice(3, i - 1), body.slice(i + 4, -1)];
    }
    return null;
  };
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const builder = (target as unknown as InMemorySupabase).from(table);
        const proxy: object = new Proxy(builder, {
          get(object, prop) {
            const value = Reflect.get(object, prop);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              const parts = prop === 'or' && typeof args[0] === 'string' ? split(args[0]) : null;
              const result = parts
                ? (object.or(parts[0]), object.or(parts[1]))
                : Reflect.apply(value, object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}

function recording(client: object) {
  return new Proxy(client, { get(target, key, receiver) { seam.touched.push(String(key)); return Reflect.get(target, key, receiver); } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://guardian-fixture.invalid');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seam.scam.mockReset().mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.touched = []; seam.sms = []; seam.calls = []; seam.attempts = 0; seam.failFor.clear();
  seed();
  seam.db = recording(splittingNestedOr(db));
  seam.service.mockReset().mockImplementation(() => seam.db);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GET /api/cron/guardian-sms-recovery', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer not-the-secret'],
  ])('API-C9192C0F02D9 JOB-7C2C80C9F161: refuses %s with 401 before any read, text or call', async (_label, authorization) => {
    const res = await GET(request(authorization));
    const status = res.status;
    const body = await res.json() as Record<string, unknown>;
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false });
    expect(seam.service).not.toHaveBeenCalled();
    expect(seam.touched).toEqual([]);
    expect(seam.attempts).toBe(0);
    expect(db.table('guardian_callback_events')).toEqual([]);
    expect(db.table('app_settings')).toEqual([]);
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: the right secret reaches each household\'s active managers once and leaves the other records alone', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ...DRAIN_EMPTY, escalations: { ...NOTHING, examined: 2, delivered: 2 } });
    expect(seam.service).toHaveBeenCalledOnce();

    // Managers only, active only: not A's teen, not A's removed adult.
    expect(smsTo()).toEqual([PHONE.aParent, PHONE.bAdult, PHONE.bParent].sort());
    // Only the critical one is also a call.
    expect(seam.calls).toEqual([PHONE.aParent]);

    expect(escalation(E.a)).toMatchObject({ notified_member_ids: [A_PARENT], sms_sent: true, call_attempted: true });
    expect(escalation(E.b)).toMatchObject({ sms_sent: true, call_attempted: false });
    expect([...(escalation(E.b).notified_member_ids as string[])].sort()).toEqual([B_PARENT, B_ADULT].sort());
    expect(claim(E.a)).toMatchObject({ status: 'processed' });
    expect(claim(E.b)).toMatchObject({ status: 'processed' });

    // Acknowledged, older than the window, already reached, nobody to call: untouched and unclaimed.
    for (const skipped of SKIPPED) {
      expect(escalation(skipped)).toMatchObject(record(skipped));
      expect(claim(skipped)).toBeUndefined();
    }
    expect(db.table('guardian_escalations')).toHaveLength(6);
    // The drain ran (its cursor exists) and found nothing to resume.
    expect(db.table('app_settings').map((r) => r.key).sort()).toEqual(['guardian.escalation_retry:cursor:v1', 'guardian.sms_intake:recovery_cursor:v1']);
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: nothing from one household\'s emergency reaches the other\'s phones or bell', async () => {
    await run();
    const textsTo = (phones: string[]) => seam.sms.filter((s) => phones.includes(s.to)).map((s) => s.body);
    for (const text of textsTo([PHONE.aParent])) {
      expect(text).toContain(E.a.description);
      expect(text).not.toContain(E.b.description);
    }
    for (const text of textsTo([PHONE.bParent, PHONE.bAdult])) {
      expect(text).toContain(E.b.description);
      expect(text).not.toContain(E.a.description);
    }
    expect(textsTo([PHONE.aParent])).toHaveLength(1);
    expect(textsTo([PHONE.bParent, PHONE.bAdult])).toHaveLength(2);
    // The in-app alert is written into each household's own bell, with its own description.
    const bell = db.table('notifications');
    expect(bell.map((n) => `${String(n.family_id)}|${String(n.body)}`).sort()).toEqual([`${A}|${E.a.description}`, `${B}|${E.b.description}`].sort());
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: a second tick texts and calls nobody again and writes no new record', async () => {
    await run();
    const attempts = seam.attempts;
    const rows = { escalations: db.table('guardian_escalations').length, bell: db.table('notifications').length, claims: db.table('guardian_callback_events').length };
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ...DRAIN_EMPTY, escalations: NOTHING });
    expect(seam.attempts).toBe(attempts);
    expect({ escalations: db.table('guardian_escalations').length, bell: db.table('notifications').length, claims: db.table('guardian_callback_events').length }).toEqual(rows);
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: a household whose sends all fail is reported (503), the other is still reached, and the next tick reaches only the one still owed', async () => {
    seam.failFor.add(PHONE.aParent);
    const first = await run();
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ ok: false, ...DRAIN_EMPTY, escalations: { ...NOTHING, examined: 2, delivered: 1, undelivered: 1 } });
    expect(escalation(E.a)).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false });
    expect(claim(E.a), 'the claim is given back for the next tick').toBeUndefined();
    expect(smsTo()).toEqual([PHONE.bAdult, PHONE.bParent].sort());

    seam.failFor.clear();
    seam.sms = []; seam.calls = [];
    const second = await run();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, ...DRAIN_EMPTY, escalations: { ...NOTHING, examined: 1, delivered: 1 } });
    expect(smsTo()).toEqual([PHONE.aParent]);
    expect(seam.calls).toEqual([PHONE.aParent]);
    expect(escalation(E.a)).toMatchObject({ notified_member_ids: [A_PARENT], sms_sent: true });
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: a receipt drain that cannot read its cursor is reported, and the emergencies still go out', async () => {
    seam.db = withFaults(splittingNestedOr(db), (table, calls: FaultCall[]) => (table === 'app_settings'
      && calls.some((c) => c.method === 'eq' && c.args[1] === 'guardian.sms_intake:recovery_cursor:v1')
      ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const { status, body } = await run();
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, examined: 0, completed: 0, busy: 0, unavailable: 1, escalations: { ...NOTHING, examined: 2, delivered: 2 } });
    expect(smsTo()).toEqual([PHONE.aParent, PHONE.bAdult, PHONE.bParent].sort());
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: an escalation ledger that cannot be read is a 503, not an empty sweep, and nobody is texted', async () => {
    seam.db = withFaults(splittingNestedOr(db), (table) => (table === 'guardian_escalations' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
    const { status, body } = await run();
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, ...DRAIN_EMPTY, escalations: { ...NOTHING, unavailable: 1 } });
    expect(seam.attempts).toBe(0);
  });

  it('API-C9192C0F02D9 JOB-7C2C80C9F161: the drain resumes each household\'s stalled text into its own records, once', async () => {
    // Two texts whose intake stopped after capture: the scam check was down.
    seam.scam.mockRejectedValue(new Error('model unavailable'));
    const smsA = `SM${'a'.repeat(32)}`, smsB = `SM${'b'.repeat(32)}`;
    expect(await receiveGuardianSms(db as never, { smsSid: smsA, from: CALLER, to: GUARDIAN_A, body: 'Running late, home by six' })).toBe('unavailable');
    expect(await receiveGuardianSms(db as never, { smsSid: smsB, from: CALLER, to: GUARDIAN_B, body: 'Pick-up moved to the side gate' })).toBe('unavailable');
    const phases = () => db.table('ai_tool_calls').filter((r) => r.tool_name === 'guardian.sms_intake').map((r) => `${String(r.family_id)}|${(r.outputs as { phase: string }).phase}`).sort();
    expect(phases()).toEqual([`${A}|captured`, `${B}|captured`].sort());

    seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
    const first = await run();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, examined: 2, completed: 2, busy: 0, unavailable: 0, escalations: { ...NOTHING, examined: 2, delivered: 2 } });
    expect(phases()).toEqual([`${A}|completed`, `${B}|completed`].sort());
    // Each text is filed under its own household, and told only to it.
    const comms = db.table('guardian_communications');
    expect(comms.map((c) => `${String(c.family_id)}|${String(c.member_id)}|${String(c.body)}`).sort())
      .toEqual([`${A}|${A_CHILD}|Running late, home by six`, `${B}|${B_CHILD}|Pick-up moved to the side gate`].sort());
    const smsNotices = db.table('notifications').filter((n) => n.related_type === 'guardian_communications');
    expect(smsNotices.length).toBeGreaterThan(0);
    for (const n of smsNotices) expect(comms.find((c) => c.id === n.related_id)?.family_id).toBe(n.family_id);

    const rows = db.table('notifications').length;
    const second = await run();
    expect(second.body).toEqual({ ok: true, ...DRAIN_EMPTY, escalations: NOTHING });
    expect(db.table('notifications')).toHaveLength(rows);
    expect(db.table('guardian_communications')).toHaveLength(2);
  });
});
