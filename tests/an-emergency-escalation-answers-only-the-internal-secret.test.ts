// An emergency escalation answers only the internal secret, and alarms only
// the household it names.
//
// POST /api/guardian/escalate texts and calls every manager of a family. It is
// server-to-server: no person signs in to it, so member roles do not apply and
// the bearer secret (GUARDIAN_INTERNAL_SECRET, else the deploy-wide
// CRON_SECRET) is the whole gate, failing closed when neither is set. These
// drive the real route over the in-memory database seeded with two
// households, with Twilio's REST sends stubbed at @/lib/guardian/twilio (the
// seam tests/an-escalation-nobody-received-is-not-a-success.test.ts stubs).
//
// Already pinned elsewhere, not repeated here: every manager role and no other
// is reached (tests/guardian-escalation-reaches-every-manager.test.ts); the
// undelivered / unreachable / partial outcomes
// (tests/an-escalation-nobody-received-is-not-a-success.test.ts); duplicate,
// claim-unavailable, members-read and record failures
// (tests/a-screening-turn-or-escalation-that-asked-for-a-retry-can-be-retried.test.ts);
// constant-time comparison (tests/shared-secrets-compare-in-constant-time.test.ts).
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, sms: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => true, sendSms: seam.sms, initiateCall: seam.call }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const SECRET = 'test-fake-guardian-internal-secret';
const CRON = 'test-fake-cron-secret';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const COMM_A = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const COMM_B = 'bbbbbbbb-0000-4000-8000-0000000000e1';
const PARENT_A_PHONE = '+15555550110';
const ADULT_A_PHONE = '+15555550111';
const PARENT_B_PHONE = '+15555550120';
const B_DESCRIPTION = 'Household B: caller says the baby is not breathing.';

let db: InMemorySupabase;
let errors: unknown[][];

function payload(overrides: Record<string, unknown> = {}) {
  return {
    familyId: FAMILY_A, commId: COMM_A, escalationType: 'emergency_call', severity: 'critical',
    description: 'Caller says there is smoke in the kitchen.', callerNumber: '+15555550199', ...overrides,
  };
}

async function escalate(authorization: string | null, body: Record<string, unknown> = payload()): Promise<[Response, Record<string, unknown>]> {
  const { POST } = await import('@/app/api/guardian/escalate/route');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  const res = await POST(new NextRequest(`${ORIGIN}/api/guardian/escalate`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return [res, await res.json() as Record<string, unknown>];
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
const texted = () => seam.sms.mock.calls.map((args) => args[0] as string);
const called = () => seam.call.mock.calls.map((args) => (args[0] as { to: string }).to);

function expectNothingHappened(): void {
  expect(db.log, 'no table was touched').toEqual([]);
  expect(db.table('notifications')).toEqual([]);
  expect(db.table('guardian_escalations')).toEqual([]);
  expect(db.table('guardian_callback_events')).toEqual([]);
  expect(seam.sms).not.toHaveBeenCalled();
  expect(seam.call).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GUARDIAN_INTERNAL_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET', CRON);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], guardian_escalations: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('families', [{ id: FAMILY_A, name: 'Household A', timezone: 'UTC' }, { id: FAMILY_B, name: 'Household B', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'm-parent-a', family_id: FAMILY_A, user_id: 'u-parent-a', display_name: 'Ada', role: 'parent', is_active: true },
    { id: 'm-adult-a', family_id: FAMILY_A, user_id: 'u-adult-a', display_name: 'Bo', role: 'adult', is_active: true },
    { id: 'm-child-a', family_id: FAMILY_A, user_id: 'u-child-a', display_name: 'Cy', role: 'child', is_active: true },
    { id: 'm-parent-b', family_id: FAMILY_B, user_id: 'u-parent-b', display_name: 'Bea', role: 'parent', is_active: true },
  ]);
  db.seed('profiles', [
    { id: 'u-parent-a', phone: PARENT_A_PHONE }, { id: 'u-adult-a', phone: ADULT_A_PHONE },
    { id: 'u-child-a', phone: '+15555550112' }, { id: 'u-parent-b', phone: PARENT_B_PHONE },
  ]);
  db.seed('guardian_communications', [{ id: COMM_B, family_id: FAMILY_B, comm_type: 'sms_inbound', direction: 'inbound', body: B_DESCRIPTION, status: 'escalated' }]);
  db.log.length = 0;
  seam.db = db;
  seam.sms.mockReset(); seam.call.mockReset();
  seam.sms.mockResolvedValue(undefined); seam.call.mockResolvedValue(undefined);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('who may call it: the internal secret only (member roles and super admin n/a: no session is read)', () => {
  it('API-DE92C0D3E1A2 a request with no Authorization is refused 401, touching no table and no phone', async () => {
    const [res, body] = await escalate(null);
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'escalate.unauthorized' });
    expectNothingHappened();
  });

  it('API-DE92C0D3E1A2 a wrong secret, and a signed-in member\'s access token, are each refused 401', async () => {
    const [wrong] = await escalate('Bearer test-fake-wrong-secret');
    expect(wrong.status).toBe(401);
    const [member] = await escalate('Bearer eyJhbGciOiJIUzI1NiJ9.test-fake-member-session.signature');
    expect(member.status).toBe(401);
    const [bare] = await escalate(SECRET);
    expect(bare.status, 'the secret without the Bearer scheme').toBe(401);
    expectNothingHappened();
  });

  it('API-DE92C0D3E1A2 with neither secret configured it is disabled, not open: even "Bearer " and "Bearer undefined" are refused', async () => {
    vi.stubEnv('GUARDIAN_INTERNAL_SECRET', '');
    vi.stubEnv('CRON_SECRET', '');
    for (const header of ['Bearer ', 'Bearer undefined', `Bearer ${SECRET}`]) {
      const [res] = await escalate(header);
      expect(res.status, header).toBe(401);
    }
    expectNothingHappened();
  });

  it('API-DE92C0D3E1A2 the cron secret is only a fallback: refused while the internal secret is set, accepted once it is not', async () => {
    const [shadowed] = await escalate(`Bearer ${CRON}`);
    expect(shadowed.status).toBe(401);
    expectNothingHappened();

    vi.stubEnv('GUARDIAN_INTERNAL_SECRET', '');
    const [fallback, body] = await escalate(`Bearer ${CRON}`);
    expect(fallback.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });
});

describe('a valid request, end to end', () => {
  it('API-DE92C0D3E1A2 texts and calls household A\'s managers, records it under A, and answers with what was sent', async () => {
    const [res, body] = await escalate(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, pushSent: true, smsSent: true, callAttempted: true, notifiedCount: 2 });

    expect(texted().sort()).toEqual([PARENT_A_PHONE, ADULT_A_PHONE].sort());
    expect(called().sort()).toEqual([PARENT_A_PHONE, ADULT_A_PHONE].sort());
    const twimlUrl = new URL((seam.call.mock.calls[0][0] as { twimlUrl: string }).twimlUrl);
    expect(`${twimlUrl.origin}${twimlUrl.pathname}`).toBe(`${ORIGIN}/api/guardian/escalate/twiml`);
    expect(twimlUrl.searchParams.get('family')).toBe(FAMILY_A);
    expect(twimlUrl.searchParams.get('msg')).toBe('Caller says there is smoke in the kitchen.');

    expect(db.table('notifications')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, user_id: null, type: 'system', body: 'Caller says there is smoke in the kitchen.',
      related_type: 'guardian_communications', related_id: COMM_A,
    })]);
    const [record] = db.table('guardian_escalations');
    expect(db.table('guardian_escalations')).toHaveLength(1);
    expect(record).toMatchObject({
      family_id: FAMILY_A, communication_id: COMM_A, escalation_type: 'emergency_call', severity: 'critical',
      caller_number: '+15555550199', push_sent: true, sms_sent: true, call_attempted: true,
    });
    expect([...(record.notified_member_ids as string[])].sort()).toEqual(['m-adult-a', 'm-parent-a']);
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({
      event_id: `escalation:communication:${COMM_A}`, callback_type: 'emergency_escalation', status: 'processed',
    })]);

    expect(ofFamily('notifications', FAMILY_B)).toEqual([]);
    expect(ofFamily('guardian_escalations', FAMILY_B)).toEqual([]);
    expect(texted()).not.toContain(PARENT_B_PHONE);
  });
});

describe('another household\'s ids', () => {
  it('API-DE92C0D3E1A2 household B\'s communication id under household A alarms nobody in B, writes nothing under B, and returns nothing of B', async () => {
    const before = structuredClone(db.table('guardian_communications'));
    const [, body] = await escalate(`Bearer ${SECRET}`, payload({ commId: COMM_B }));
    expect(texted()).not.toContain(PARENT_B_PHONE);
    expect(called()).not.toContain(PARENT_B_PHONE);
    expect(ofFamily('notifications', FAMILY_B)).toEqual([]);
    expect(ofFamily('guardian_escalations', FAMILY_B)).toEqual([]);
    expect(db.table('guardian_communications'), 'B\'s communication is unchanged').toEqual(before);
    expect(JSON.stringify(body)).not.toContain(B_DESCRIPTION);
    expect(JSON.stringify(body)).not.toContain(FAMILY_B);
    expect(JSON.stringify(db.table('notifications'))).not.toContain(B_DESCRIPTION);
  });
});

describe('a failed read', () => {
  it('API-DE92C0D3E1A2 an unreadable phone lookup is a 500 with a fixed message, no internal error text, and nobody texted', async () => {
    refuse(db, 'profiles', 'permission denied for table profiles (internal detail)');
    const [res, body] = await escalate(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'escalate.unableToProcessEscalation' });
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(seam.sms).not.toHaveBeenCalled();
    expect(seam.call).not.toHaveBeenCalled();
    expect(db.table('guardian_escalations')).toEqual([]);
    expect(db.table('guardian_callback_events'), 'the claim was given back for a retry').toEqual([]);
    expect(errors.some((args) => /could not load member phone numbers/.test(String(args[0])))).toBe(true);
  });
});
