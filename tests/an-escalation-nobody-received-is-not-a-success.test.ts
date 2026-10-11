// An escalation that reached no manager's phone is not a success.
//
// POST /api/guardian/escalate with severity critical, and every sendSms /
// initiateCall throws (Twilio 4xx/5xx, a timeout), or no manager has a phone,
// or Twilio is unconfigured. The errors were swallowed with
// `catch { /* non-fatal */ }` and nothing was logged; notifiedIds.push(m.id)
// ran BEFORE the send, so a manager whose SMS failed was still recorded as
// told; the route wrote guardian_escalations with sms_sent=false and
// call_attempted=false, marked the claim processed and answered 200 {ok:true}.
// A retry was answered as a duplicate, so the emergency counted as handled
// with nobody reached beyond an unaddressed in-app row.
//
// Now: a member is recorded as notified only after a send to them succeeded;
// every failure is logged with the family and the callback; zero deliveries
// where there was somebody to reach is a non-2xx with the claim given back; and
// the dashboard says when nobody was reached. Nobody to reach at all (no
// manager with a phone on file) is `unreachable`: still not `ok`, still on the
// dashboard, but complete rather than left for a retry that would find the
// same. (Twilio unconfigured is pinned beside the other escalation retry cases
// in tests/a-screening-turn-or-escalation-that-asked-for-a-retry-can-be-retried.test.ts.)
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ db: null as unknown, sms: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db }));
vi.mock('@/lib/guardian/twilio', () => ({ isTwilioConfigured: () => true, sendSms: seam.sms, initiateCall: seam.call }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const COMM = '00000000-0000-4000-8000-000000000a01';
const SECRET = 'escalation-test-secret';
const PARENT_PHONE = '+15550000001';
const ADULT_PHONE = '+15550000002';

let db: InMemorySupabase;
let errors: unknown[][];

async function escalate() {
  const { POST } = await import('@/app/api/guardian/escalate/route');
  const res = await POST(new NextRequest('http://localhost/api/guardian/escalate', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ familyId: FAMILY, commId: COMM, escalationType: 'emergency_call', severity: 'critical', description: 'Caller says there is smoke in the kitchen.', callerNumber: '+15550000000' }),
  }));
  return [res, await res.json()] as const;
}

/** One table answers every call with a RESOLVED error, the way PostgREST does. */
function refuse(client: InMemorySupabase, table: string): void {
  const before = client.from.bind(client);
  const reply = { data: null, error: { code: '42501', message: 'permission denied' }, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === table ? chain : before(name))) as InMemorySupabase['from'];
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GUARDIAN_INTERNAL_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://guardian-fixture.invalid');
  db = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']], notifications: [['id']], guardian_escalations: [['id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', display_name: 'Ada', role: 'parent', is_active: true },
    { id: 'm-adult', family_id: FAMILY, user_id: 'u-adult', display_name: 'Bo', role: 'adult', is_active: true },
    { id: 'm-child', family_id: FAMILY, user_id: 'u-child', display_name: 'Dev', role: 'child', is_active: true },
  ]);
  db.seed('profiles', [{ id: 'u-parent', phone: PARENT_PHONE }, { id: 'u-adult', phone: ADULT_PHONE }, { id: 'u-child', phone: '+15550000003' }]);
  seam.db = db;
  seam.sms.mockReset(); seam.call.mockReset();
  seam.sms.mockResolvedValue(undefined); seam.call.mockResolvedValue(undefined);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const escalation = () => db.table('guardian_escalations')[0];

describe('when every text and call fails', () => {
  it('answers non-2xx, records nobody as told, logs each failure with the family and callback, and leaves the claim retryable', async () => {
    seam.sms.mockRejectedValue(new Error('Twilio 503'));
    seam.call.mockRejectedValue(new Error('Twilio 503'));
    const [res, body] = await escalate();
    // The defect: 200 { ok: true } with notified_member_ids ['m-parent', 'm-adult'].
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, delivered: false, notifiedCount: 0 });
    expect(db.table('guardian_escalations')).toHaveLength(1);
    expect(escalation()).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false, push_sent: true });
    expect(db.table('guardian_callback_events'), 'the claim was given back, not marked processed').toEqual([]);
    const logged = errors.filter((args) => /escalation (SMS|call) failed/.test(String(args[0])));
    expect(logged).toHaveLength(4);
    for (const args of logged) expect(args[1]).toMatchObject({ familyId: FAMILY, callbackId: `escalation:communication:${COMM}` });
    expect(errors.some((args) => /reached no manager by SMS or call/.test(String(args[0])))).toBe(true);

    // The retry is processed, and succeeds once telephony is back.
    seam.sms.mockResolvedValue(undefined); seam.call.mockResolvedValue(undefined);
    const [retry, again] = await escalate();
    expect(retry.status).toBe(200);
    expect(again).toMatchObject({ ok: true, notifiedCount: 2, smsSent: true, callAttempted: true });
    expect(db.table('guardian_escalations'), 'the record is updated in place').toHaveLength(1);
    expect([...(escalation().notified_member_ids as string[])].sort()).toEqual(['m-adult', 'm-parent']);
    expect(db.table('notifications'), 'the in-app row is not written twice').toHaveLength(1);
  });
});

describe('when no manager has a phone on file', () => {
  it('is unreachable: recorded with nobody to tell, not ok, and not left for a retry that would find the same', async () => {
    db.replace('profiles', [{ id: 'u-parent', phone: null }, { id: 'u-adult', phone: null }, { id: 'u-child', phone: '+15550000003' }]);
    const [res, body] = await escalate();
    // Not the 200 { ok: true } of old, and not the 503 of the first fix either:
    // that asked for a retry of something no retry can mend, and the lanes that
    // honoured it re-ran every five minutes until a phone was added.
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, delivered: false, unreachable: true, notifiedCount: 0 });
    expect(seam.sms).not.toHaveBeenCalled();
    // NULL, not []: nobody COULD be told. The dashboard renders both as nobody
    // reached; the retry sweep reads the difference.
    expect(escalation()).toMatchObject({ notified_member_ids: null, sms_sent: false, call_attempted: false, push_sent: true });
    expect(db.table('guardian_callback_events'), 'as handled as it can be').toEqual([expect.objectContaining({ status: 'processed' })]);
    expect(errors.filter((args) => /no phone on file/.test(String(args[0])))).toHaveLength(2);
    expect(errors.some((args) => /nobody to text or call/.test(String(args[0])))).toBe(true);

    // A retry is a duplicate, and alarms nobody.
    const [retry, again] = await escalate();
    expect(retry.status).toBe(200);
    expect(again).toEqual({ ok: true, duplicate: true });
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('guardian_escalations')).toHaveLength(1);
  });

  it('one manager without a phone beside one whose sends failed is undelivered, not unreachable: there was somebody to reach', async () => {
    db.replace('profiles', [{ id: 'u-parent', phone: null }, { id: 'u-adult', phone: ADULT_PHONE }, { id: 'u-child', phone: '+15550000003' }]);
    seam.sms.mockRejectedValue(new Error('Twilio 503'));
    seam.call.mockRejectedValue(new Error('Twilio 503'));
    const [res, body] = await escalate();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, delivered: false, notifiedCount: 0 });
    expect(body).not.toHaveProperty('unreachable');
    expect(escalation()).toMatchObject({ notified_member_ids: [], sms_sent: false, call_attempted: false });
    expect(db.table('guardian_callback_events'), 'given back for the retry').toEqual([]);
  });
});

describe('a manager is recorded as told only when a send to them succeeded', () => {
  it('one reached by the call after a failed text counts; one whose text and call both failed does not', async () => {
    seam.sms.mockRejectedValue(new Error('Twilio 400'));
    seam.call.mockImplementation(async ({ to }: { to: string }) => { if (to !== PARENT_PHONE) throw new Error('Twilio 400'); });
    const [res, body] = await escalate();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, notifiedCount: 1, smsSent: false, callAttempted: true });
    expect(escalation()).toMatchObject({ notified_member_ids: ['m-parent'], sms_sent: false, call_attempted: true });
    expect(db.table('guardian_callback_events')).toEqual([expect.objectContaining({ status: 'processed' })]);
  });

  it('a refused in-app write is recorded as push_sent false, not true', async () => {
    refuse(db, 'notifications');
    const [res, body] = await escalate();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, pushSent: false, smsSent: true });
    expect(escalation()).toMatchObject({ push_sent: false, sms_sent: true });
    expect(errors.some((args) => /escalation notification write failed/.test(String(args[0])))).toBe(true);
  });
});

describe('the Guardian dashboard', () => {
  it('reads who was reached and says when nobody was', () => {
    const page = readFileSync('app/(app)/guardian/page.tsx', 'utf8');
    expect(page).toMatch(/from\('guardian_escalations'\)\s*\.select\('[^']*notified_member_ids[^']*'\)/);
    const dashboard = readFileSync('components/guardian/guardian-dashboard.tsx', 'utf8');
    expect(dashboard).toMatch(/\(esc\.notified_member_ids \?\? \[\]\)\.length === 0 &&/);
    expect(dashboard).toContain("t('guardianDashboard.noManagerReachedByPhone')");
    const catalogue = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
    expect(catalogue['guardianDashboard.noManagerReachedByPhone']).toBeTruthy();
  });
});
