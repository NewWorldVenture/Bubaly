// The same rule as tests/a-callback-that-asked-for-a-retry-can-be-retried.test.ts,
// for the two Guardian routes that still broke it.
//
// /api/guardian/screen answers 503 ("letting Twilio fall back") when the
// session, the communication or the member profile cannot be read, with the
// claim still held — so the fallback's attempt at the same turn was a 'settled'
// duplicate for ten minutes: thanked, hung up on, and lost.
//
// /api/guardian/escalate marked its claim `error` when the members or their
// phones could not be read, "leaving the claim retryable" — but an `error` row
// is reclaimable only after ten minutes, so the caller's retry inside that
// window was answered `{ ok: true, duplicate: true }`: an emergency escalation
// reported as handled when nobody had been told. Its third failure, after the
// alerts have gone out, keeps `error` on purpose, and that asymmetry is pinned
// here too.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { guardianEscalationEventId } from '@/lib/guardian/escalation';

const seam = vi.hoisted(() => ({ service: vi.fn(), turn: vi.fn(), sms: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/guardian/ai-screen', () => ({ screeningTurn: seam.turn, summarizeScreening: async () => 'summary' }));
// The TwiML helpers stay real; only the outbound telephony is stubbed, and
// isTwilioConfigured() false keeps the escalation on its push-only path.
vi.mock('@/lib/guardian/twilio', async (original) => ({
  ...await original<typeof import('@/lib/guardian/twilio')>(),
  isTwilioConfigured: () => false, sendSms: seam.sms, initiateCall: seam.call,
}));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const SECRET = 'guardian-internal-fixture-secret';
const FAMILY = '00000000-0000-4000-8000-00000000f001';
const SESSION = '00000000-0000-4000-8000-00000000c0a1';
const COMM = '00000000-0000-4000-8000-00000000c0c1';
const CALL = `CA${'c'.repeat(32)}`;
const SCREEN_EVENT = `${CALL}:screen:1`;
const MINUTE = 60_000;
const REFUSED = { code: '57014', message: 'canceling statement due to statement timeout' };
const ESCALATION = {
  familyId: FAMILY, commId: COMM, escalationType: 'emergency_call', severity: 'high',
  description: 'Caller says there is smoke in the kitchen.', callerNumber: '+15550000000',
} as const;
const ESCALATION_EVENT = guardianEscalationEventId(ESCALATION);

let db: InMemorySupabase;
let errors: unknown[][];

/** The callback table as 0181 declares it, with the clock default added at insert time. */
function database(): InMemorySupabase {
  const fresh = createInMemorySupabase({
    uniques: { guardian_callback_events: [['event_id']] },
    defaults: { guardian_callback_events: { status: 'processing', processed_at: null, error: null } },
  });
  const realFrom = fresh.from.bind(fresh);
  fresh.from = ((table: string) => {
    const query = realFrom(table);
    if (table !== 'guardian_callback_events') return query;
    const realInsert = query.insert.bind(query);
    query.insert = (rows) => realInsert((Array.isArray(rows) ? rows : [rows]).map((row) => ({ received_at: new Date().toISOString(), ...row })));
    return query;
  }) as InMemorySupabase['from'];
  return fresh;
}

/** One table answers every call with a RESOLVED error, the way PostgREST does; returns the cure. */
function refuse(client: InMemorySupabase, table: string, error: { code: string; message: string }): () => void {
  const before = client.from;
  const reply = { data: null, error, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === table ? chain : before(name))) as InMemorySupabase['from'];
  return () => { client.from = before; };
}

const events = () => db.table('guardian_callback_events');
const reads = (table: string) => db.log.filter((entry) => entry.table === table).length;

/** A Gather callback for turn 1 of SESSION, signed the way Twilio signs: over the full URL, query included. */
async function screen(): Promise<[Response, string]> {
  const url = `${ORIGIN}/api/guardian/screen?sessionId=${SESSION}&turn=1`;
  const form = { CallSid: CALL, SpeechResult: 'Hi, it is Grandma.' };
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k as keyof typeof form]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  const { POST } = await import('@/app/api/guardian/screen/route');
  const res = await POST(new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(form).toString(),
  }));
  return [res, await res.text()];
}

async function escalate(): Promise<[Response, unknown]> {
  const { POST } = await import('@/app/api/guardian/escalate/route');
  const res = await POST(new NextRequest(`${ORIGIN}/api/guardian/escalate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(ESCALATION),
  }));
  return [res, await res.json()];
}

const goodbye = (res: Response, body: string) => {
  expect(res.status).toBe(200);
  expect(body).toContain('screen.thankYouForCallingGoodbye');
  expect(body).toContain('<Hangup />');
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('GUARDIAN_INTERNAL_SECRET', SECRET);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  db = database();
  errors = [];
  seam.service.mockImplementation(() => db);
  seam.turn.mockRejectedValue(new Error('the AI turn is not part of these cases'));
  db.seed('families', [{ id: FAMILY, name: 'Fixture' }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', display_name: 'Ada', role: 'parent', is_active: true }]);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('the screening Gather callback', () => {
  // A session that is no longer active is the cheapest completed turn: the
  // route says goodbye and records the callback, without the AI.
  const closedSession = () => db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: '+15559999999', turn: 0, status: 'completed', messages: [] }]);
  const liveSession = () => db.seed('guardian_screening_sessions', [{ id: SESSION, family_id: FAMILY, communication_id: COMM, twilio_call_sid: CALL, caller_number: '+15559999999', turn: 0, status: 'active', messages: [] }]);

  it('claims a first delivery, completes the turn, and records it as processed', async () => {
    closedSession();
    const [res, body] = await screen();
    goodbye(res, body);
    expect(events()).toEqual([expect.objectContaining({ event_id: SCREEN_EVENT, callback_type: 'screening_gather', status: 'processed' })]);
    expect(reads('guardian_screening_sessions')).toBe(1);
  });

  it('acknowledges an exact retry of a processed turn without reading the session again', async () => {
    closedSession();
    await screen();
    const [res, body] = await screen();
    goodbye(res, body);
    expect(reads('guardian_screening_sessions')).toBe(1);
  });

  it('acknowledges a retry while another worker holds a fresh claim', async () => {
    closedSession();
    db.seed('guardian_callback_events', [{ event_id: SCREEN_EVENT, callback_type: 'screening_gather', status: 'processing', received_at: new Date(Date.now() - MINUTE).toISOString(), processed_at: null, error: null }]);
    const [res, body] = await screen();
    goodbye(res, body);
    expect(reads('guardian_screening_sessions')).toBe(0);
    expect(events()[0].status).toBe('processing');
  });

  it('reclaims a claim abandoned for more than ten minutes', async () => {
    closedSession();
    db.seed('guardian_callback_events', [{ event_id: SCREEN_EVENT, callback_type: 'screening_gather', status: 'processing', received_at: new Date(Date.now() - 11 * MINUTE).toISOString(), processed_at: null, error: null }]);
    const [res, body] = await screen();
    goodbye(res, body);
    expect(reads('guardian_screening_sessions')).toBe(1);
    expect(events()[0].status).toBe('processed');
  });

  it('asks Twilio to fall back when the claim itself cannot be written, touching nothing else', async () => {
    closedSession();
    refuse(db, 'guardian_callback_events', { code: '42501', message: 'permission denied' });
    const [res] = await screen();
    expect(res.status).toBe(503);
    expect(reads('guardian_screening_sessions')).toBe(0);
  });

  it('gives the claim back when the session cannot be read, so the fallback can take the turn', async () => {
    // The defect. The fallback's attempt at this turn used to be thanked and
    // hung up on as a duplicate, because the first attempt still held the claim.
    closedSession();
    const heal = refuse(db, 'guardian_screening_sessions', REFUSED);
    const [first] = await screen();
    expect(first.status).toBe(503);
    expect(events(), 'a claim held after asking for a fallback is a fallback refused').toEqual([]);
    expect(errors.some((args) => /session read failed/.test(String(args[0])))).toBe(true);

    heal();
    const [retry, body] = await screen();
    goodbye(retry, body);
    expect(events()).toEqual([expect.objectContaining({ event_id: SCREEN_EVENT, status: 'processed' })]);
  });

  it('gives the claim back when the communication cannot be read', async () => {
    liveSession();
    refuse(db, 'guardian_communications', REFUSED);
    const [res] = await screen();
    expect(res.status).toBe(503);
    expect(events()).toEqual([]);
    expect(seam.turn, 'no AI turn ran').not.toHaveBeenCalled();
  });

  it('gives the claim back when the member profile cannot be read', async () => {
    liveSession();
    db.seed('guardian_communications', [{ id: COMM, family_id: FAMILY, member_id: 'm-parent', status: 'screening' }]);
    refuse(db, 'guardian_member_profiles', REFUSED);
    const [res] = await screen();
    expect(res.status).toBe(503);
    expect(events()).toEqual([]);
    expect(seam.turn).not.toHaveBeenCalled();
    expect(db.table('guardian_screening_sessions')[0].turn, 'the turn was not consumed').toBe(0);
  });
});

describe('the emergency escalation', () => {
  it('records and completes a first request, and acknowledges an exact retry as the duplicate it is', async () => {
    const [first, body] = await escalate();
    expect(first.status).toBe(200);
    expect(body).toMatchObject({ ok: true, pushSent: true, smsSent: false, callAttempted: false });
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('guardian_escalations')).toHaveLength(1);
    expect(events()).toEqual([expect.objectContaining({ event_id: ESCALATION_EVENT, callback_type: 'emergency_escalation', status: 'processed' })]);

    const [retry, again] = await escalate();
    expect(retry.status).toBe(200);
    expect(again).toEqual({ ok: true, duplicate: true });
    expect(db.table('notifications'), 'the family is not alarmed twice').toHaveLength(1);
    expect(reads('family_members')).toBe(1);
  });

  it('asks for a retry when the claim itself cannot be written, before any read', async () => {
    refuse(db, 'guardian_callback_events', { code: '42501', message: 'permission denied' });
    const [res, body] = await escalate();
    expect(res.status).toBe(503);
    expect(body).toEqual({ error: 'Escalation claim unavailable' });
    expect(reads('family_members')).toBe(0);
  });

  it('gives the claim back when the members cannot be read, so a retry inside ten minutes is processed', async () => {
    // The defect. Marked `error`, the claim was reclaimable only after ten
    // minutes; inside them the retry below was answered { ok: true, duplicate:
    // true } with no notification, no record, and nobody told.
    const heal = refuse(db, 'family_members', REFUSED);
    const [first, body] = await escalate();
    expect(first.status).toBe(500);
    expect(body).toEqual({ error: 'escalate.unableToProcessEscalation' });
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('guardian_escalations')).toEqual([]);
    expect(events(), 'the claim was given back, not parked as an error').toEqual([]);
    expect(errors.some((args) => /could not load family members; releasing the claim/.test(String(args[0])))).toBe(true);

    heal();
    const [retry, again] = await escalate();
    expect(retry.status).toBe(200);
    expect(again).toMatchObject({ ok: true, pushSent: true });
    expect(db.table('notifications')).toHaveLength(1);
    expect(db.table('guardian_escalations')).toHaveLength(1);
    expect(events()).toEqual([expect.objectContaining({ event_id: ESCALATION_EVENT, status: 'processed' })]);
  });

  it('keeps the claim as an error when the record fails AFTER the alerts went out, so a retry inside ten minutes does not alarm twice', async () => {
    // The deliberate asymmetry. By this point the family-wide notification has
    // been written (and, with telephony configured, every manager texted and
    // called); the ten minutes before an `error` row can be reclaimed is what
    // keeps an immediate retry from doing all of that again. The cost is a
    // missing escalation record, which the 500 and the row's `error` text name.
    refuse(db, 'guardian_escalations', REFUSED);
    const [first, body] = await escalate();
    expect(first.status).toBe(500);
    expect(body).toEqual({ error: 'escalate.unableToProcessEscalation' });
    expect(db.table('notifications'), 'the alert had already gone out').toHaveLength(1);
    expect(events()).toEqual([expect.objectContaining({ event_id: ESCALATION_EVENT, status: 'error', error: 'Unable to record escalation.' })]);

    const [retry, again] = await escalate();
    expect(retry.status).toBe(200);
    expect(again).toEqual({ ok: true, duplicate: true });
    expect(db.table('notifications')).toHaveLength(1);
  });
});
