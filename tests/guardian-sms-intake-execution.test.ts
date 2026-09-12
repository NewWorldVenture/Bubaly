import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ client: undefined as unknown as SupabaseClient, factory: vi.fn(), pipeline: vi.fn(), scam: vi.fn(), notify: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.factory }));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/services/scope', async original => ({ ...await original<typeof import('@/lib/services/scope')>(), systemScopeForFamily: seam.scope }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const COMM = '33333333-3333-4333-8333-333333333333';
const NOTIFICATION = '44444444-4444-4444-8444-444444444444';
const SID = `SM${'a'.repeat(32)}`;
type Row = Record<string, unknown>;
type Call = { table: string; method: string; body: Row | Row[] | null; url: URL; signal?: AbortSignal | null };
let calls: Call[] = [], failure: 'claim' | 'profile' | 'communication' | 'saved-read' | 'finish' | 'release' | 'notification-read' | 'scope' | null = null;
let event: Row | null = null;
let communication: Row | null = null;
let profiles: Row[], notifications: Row[], quietHours: Row | null;
let lostCommunication = false, nullCommunicationReceipt = false, lostNotification = false, profileCount: number | null | undefined;
let held: 'profile' | 'communication' | null = null;
function matches(row: Row, url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (value.startsWith('eq.') && String(row[key]) !== value.slice(3)) return false;
    if (value === 'is.null' && row[key] !== null && row[key] !== undefined) return false;
    if (value.startsWith('lt.') && String(row[key]) >= value.slice(3)) return false;
    if (value.startsWith('in.(') && !value.slice(4, -1).split(',').includes(String(row[key]))) return false;
  }
  return true;
}
function selected(rows: Row[], url: URL, init: RequestInit, status = 200, count: number | null = rows.length) {
  const data = rows.slice(0, Number(url.searchParams.get('limit') ?? rows.length));
  const single = new Headers(init.headers).get('accept')?.includes('application/vnd.pgrst.object+json');
  return Response.json(single ? data[0] ?? null : data, { status, headers: count === null ? {} : { 'content-range': `0-${Math.max(0, data.length - 1)}/${count}` } });
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN); vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live transport prohibited in fixture'); }));
  calls = []; event = null; communication = null; failure = null;
  profiles = [{ id: MEMBER, family_id: FAMILY, member_id: MEMBER, guardian_phone: '+15555550100', is_active: true }];
  notifications = []; quietHours = null; lostCommunication = false; nullCommunicationReceipt = false; lostNotification = false; profileCount = undefined;
  held = null;
  seam.factory.mockImplementation(() => seam.client);
  seam.pipeline.mockResolvedValue({ contactId: null, contactName: null, trustLevel: 'known_contact', routingMode: 'ai_handle_first', ruleId: null, reason: 'Synthetic permitted message' });
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.scope.mockResolvedValue({ familyId: FAMILY }); seam.notify.mockResolvedValue({ ok: true, data: { created: 1, ids: [NOTIFICATION], duplicates: 0, deferred: 0, skippedMemberIds: [] } });
  seam.client = createClient('https://guardian-db-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw));
      const table = url.pathname.split('/').at(-1)!;
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : null;
      calls.push({ table, method, body, url, signal: init.signal });
      if ((held === 'profile' && table === 'guardian_member_profiles') || (held === 'communication' && table === 'guardian_communications' && method === 'POST')) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(init.signal?.reason);
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const error = () => Response.json({ code: 'PGRST000', message: 'Synthetic required storage outage' }, { status: 503, headers: { 'retry-after': '0' } });
      if (table === 'guardian_callback_events' && method === 'POST') {
        if (failure === 'claim') return error();
        if (event) return Response.json({ code: '23505', message: 'Synthetic unique event ID' }, { status: 409 });
        event = { status: 'processing', received_at: new Date().toISOString(), processed_at: null, error: null, ...body };
        return selected([event], url, init, 201);
      }
      if (table === 'guardian_callback_events' && method === 'GET') {
        return selected(event && matches(event, url) ? [event] : [], url, init);
      }
      if (table === 'guardian_callback_events' && method === 'PATCH') {
        if ((failure === 'finish' && body?.status === 'processed') || (failure === 'release' && body?.status === 'error')) return error();
        const matched = event && matches(event, url) ? event : null;
        if (matched) Object.assign(matched, body);
        return selected(matched ? [matched] : [], url, init);
      }
      if (table === 'guardian_member_profiles' && method === 'GET') {
        if (failure === 'profile') return error();
        const found = profiles.filter(row => matches(row, url));
        return selected(found, url, init, 200, profileCount === undefined ? found.length : profileCount);
      }
      if (table === 'guardian_communications' && method === 'GET') {
        if (failure === 'saved-read') return error();
        return selected(communication && matches(communication, url) ? [communication] : [], url, init);
      }
      if (table === 'guardian_communications' && method === 'POST') {
        if (failure === 'communication') return error();
        if (communication) return Response.json({ code: '23505', message: 'Synthetic unique SMS SID' }, { status: 409 });
        communication = { ...body, id: COMM };
        if (lostCommunication) throw new Error('Synthetic lost response after committed message');
        if (nullCommunicationReceipt) return Response.json(null, { status: 201 });
        return selected([{ id: COMM }], url, init, 201);
      }
      if (table === 'families' && method === 'GET') return failure === 'scope' ? error() : selected([{ id: FAMILY, timezone: 'UTC' }], url, init);
      if (table === 'family_ai_settings' && method === 'GET') return selected(quietHours ? [quietHours] : [], url, init);
      if (table === 'notifications' && method === 'GET') return failure === 'notification-read' ? error() : selected(notifications.filter(row => matches(row, url)), url, init);
      if (table === 'notifications' && method === 'POST') {
        const rows = (Array.isArray(body) ? body : [body]).map(row => ({ ...row, id: NOTIFICATION, is_read: false, sent_at: null, pushed_at: null }));
        notifications.push(...rows);
        if (lostNotification) throw new Error('Synthetic lost response after committed notification');
        return selected(rows, url, init, 201);
      }
      throw new Error(`Unexpected fixture operation ${method} ${table}`);
    } },
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function deliver(valid = true, overrides: Record<string, string> = {}, duplicate?: string) {
  const fields: Record<string, string> = { From: '+15555550200', To: '+15555550100', Body: 'Dentist appointment tomorrow', SmsSid: SID, ...overrides };
  const url = `${ORIGIN}/api/guardian/inbound/sms`;
  const signature = createHmac('sha1', TOKEN).update(url + Object.keys(fields).sort().map(key => key + fields[key]).join('')).digest('base64');
  const { POST } = await import('@/app/api/guardian/inbound/sms/route');
  const encoded = new URLSearchParams(fields); if (duplicate) encoded.append(duplicate, fields[duplicate]);
  return POST(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': valid ? signature : 'invalid' },
    body: new TextEncoder().encode(encoded.toString()) }));
}
async function useRealNotifications() {
  seam.notify.mockImplementation((await vi.importActual<typeof import('@/lib/services/notifications')>('@/lib/services/notifications')).notify);
  seam.scope.mockImplementation((await vi.importActual<typeof import('@/lib/services/scope')>('@/lib/services/scope')).systemScopeForFamily);
}

describe('actual signed Guardian SMS route through installed PostgREST SDK', () => {
  it.each(['claim', 'profile', 'communication'] as const)('does not acknowledge the inbound message after required %s storage fails', async stage => {
    failure = stage;
    const response = await deliver();
    expect(response.status, JSON.stringify({ stage, acknowledged: response.status, savedCommunication: !!communication, eventStatus: event?.status, notifications: seam.notify.mock.calls.length })).toBe(503);
    expect(event?.status).not.toBe('processed');
    expect(communication).toBeNull(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it('acknowledges one healthy saved message and sends its exact related receipt', async () => {
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ id: COMM, family_id: FAMILY, member_id: MEMBER, twilio_sms_sid: SID, direction: 'inbound' });
    expect(event?.status).toBe('processed');
    expect(seam.notify).toHaveBeenCalledExactlyOnceWith({ familyId: FAMILY }, expect.objectContaining({ relatedId: COMM, relatedType: 'guardian_communications' }));
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it('rejects an invalid production signature before creating any database client', async () => {
    expect((await deliver(false)).status).toBe(401);
    expect(seam.factory).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['claim', 'profile', 'communication'] as const)('recovers a required %s failure on retry without losing the message', async stage => {
    failure = stage; expect((await deliver()).status).toBe(503);
    failure = null; expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ id: COMM, twilio_sms_sid: SID });
    expect(event?.status).toBe('processed'); expect(seam.notify).toHaveBeenCalledOnce();
  });
  it('acknowledges a confirmed processed duplicate without rerunning classifiers or notification', async () => {
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.scam).toHaveBeenCalledOnce(); expect(seam.notify).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it('returns unavailable for an active processing claim rather than falsely acknowledging completion', async () => {
    event = { event_id: SID, callback_type: 'inbound_sms', status: 'processing', received_at: new Date().toISOString(), processed_at: null, error: `sms-lease:${COMM}` };
    expect((await deliver()).status).toBe(503);
    expect(seam.pipeline).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it('keeps a clean empty destination lookup distinct from unavailable storage', async () => {
    profiles = [];
    expect((await deliver()).status).toBe(200); expect(event?.status).toBe('processed');
    expect(communication).toBeNull(); expect(seam.pipeline).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['multiple', 'cap-hidden', 'missing-count', 'invalid-id', 'wrong-phone'])('rejects an unusable destination receipt: %s', async mode => {
    if (mode === 'multiple') profiles.push({ ...profiles[0], id: COMM, family_id: COMM });
    if (mode === 'cap-hidden') profileCount = 2;
    if (mode === 'missing-count') profileCount = null;
    if (mode === 'invalid-id') profiles[0].family_id = 'malformed';
    if (mode === 'wrong-phone') { profiles[0].guardian_phone = '+15555550199'; profileCount = 1; }
    expect((await deliver()).status).toBe(503); expect(event?.status).toBe('error');
    expect(communication).toBeNull(); expect(seam.pipeline).not.toHaveBeenCalled();
  });
  it('does not insert or classify when the required saved-message read fails', async () => {
    failure = 'saved-read';
    expect((await deliver()).status).toBe(503);
    expect(seam.pipeline).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(0);
  });
  it.each(['lost-response', 'null-receipt'])('reconciles %s after a committed insert by the exact saved SID receipt', async mode => {
    lostCommunication = mode === 'lost-response'; nullCommunicationReceipt = mode === 'null-receipt';
    expect((await deliver()).status).toBe(200);
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ relatedId: COMM, once: true });
  });
  it.each(['family_id', 'member_id', 'to_number', 'from_number', 'body', 'id', 'routing_mode_used', 'scam_confidence'])('rejects conflicting saved communication %s before replay notification', async field => {
    seam.notify.mockResolvedValue({ ok: false, error: 'Synthetic notification outage' });
    expect((await deliver()).status).toBe(503); expect(communication).not.toBeNull();
    const altered = communication as unknown as Row;
    altered[field] = field === 'scam_confidence' ? 80.5 : 'mismatched';
    seam.notify.mockClear();
    expect((await deliver()).status).toBe(503); expect(seam.notify).not.toHaveBeenCalled();
    expect(seam.pipeline).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it.each([79.9, 80.9])('normalizes fractional confidence %s to the integer schema without moving the blocking threshold', async confidence => {
    seam.scam.mockResolvedValue({ isScam: true, scamType: 'phishing', confidence });
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ scam_confidence: Math.floor(confidence), status: confidence >= 80 ? 'blocked' : 'received' });
    expect(seam.notify).toHaveBeenCalledTimes(confidence >= 80 ? 0 : 1);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101, '80'])('does not persist invalid classifier confidence %s', async confidence => {
    seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence });
    expect((await deliver()).status).toBe(503); expect(communication).toBeNull(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['pipeline', 'scam', 'scope', 'notification'])('contains a thrown %s prerequisite and releases the exact lease for retry', async stage => {
    const target = stage === 'pipeline' ? seam.pipeline : stage === 'scam' ? seam.scam : stage === 'scope' ? seam.scope : seam.notify;
    target.mockRejectedValue(new Error('Synthetic required dependency unavailable'));
    expect((await deliver()).status).toBe(503); expect(event?.status).toBe('error');
  });
  it.each([
    { created: 0, ids: [], duplicates: 0 }, { created: 1, ids: [], duplicates: 0 },
    { created: 1, ids: ['malformed'], duplicates: 0 }, { created: 1, ids: [NOTIFICATION], duplicates: 1 },
  ])('does not acknowledge a malformed notification success summary %j', async data => {
    seam.notify.mockResolvedValue({ ok: true, data });
    expect((await deliver()).status).toBe(503); expect(event?.status).toBe('error');
    expect(communication).toMatchObject({ id: COMM });
  });
  it('requires an exact owned finish receipt even after notification succeeds', async () => {
    failure = 'finish';
    expect((await deliver()).status).toBe(503); expect(event?.status).toBe('processing');
    expect(seam.notify).toHaveBeenCalledOnce();
    expect((await deliver()).status).toBe(503); expect(seam.notify).toHaveBeenCalledOnce();
  });
  it('cannot finish or release a lease replaced while notification was pending', async () => {
    seam.notify.mockImplementation(async () => {
      if (event) event.error = `sms-lease:${NOTIFICATION}`;
      return { ok: true, data: { created: 1, ids: [NOTIFICATION], duplicates: 0 } };
    });
    expect((await deliver()).status).toBe(503);
    expect(event).toMatchObject({ status: 'processing', error: `sms-lease:${NOTIFICATION}` });
  });
  it.each([{ To: '' }, { To: 'not-a-number' }, { SmsSid: '' }, { SmsSid: 'not-a-sid' }, { MessageSid: `SM${'b'.repeat(32)}` }, { From: 'x\nheader' }, { Body: 'x'.repeat(4097) }] as Array<Record<string, string>>)('rejects invalid signed input before database work: %j', async fields => {
    expect((await deliver(true, fields)).status).toBe(400);
    expect(seam.factory).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['To', 'From', 'SmsSid', 'Body'])('rejects duplicate %s form fields before database work', async field => {
    expect((await deliver(true, {}, field)).status).toBe(400); expect(seam.factory).not.toHaveBeenCalled();
  });
  it('preserves alphanumeric sender and accepts the messaging-resource MM SID without claiming media processing', async () => {
    expect((await deliver(true, { From: 'Dentist', SmsSid: `MM${'c'.repeat(32)}` })).status).toBe(200);
    expect(communication).toMatchObject({ from_number: 'Dentist', twilio_sms_sid: `MM${'c'.repeat(32)}` });
  });
  it('normalizes a configured trailing slash without trusting the callback request host for its HMAC', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', ` ${ORIGIN}/ `);
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ twilio_sms_sid: SID });
  });
  it('uses bounded abort signals on every direct required route query', async () => {
    expect((await deliver()).status).toBe(200);
    expect(calls.filter(call => ['guardian_member_profiles', 'guardian_communications'].includes(call.table)).every(call => call.signal instanceof AbortSignal)).toBe(true);
  });
  it.each(['profile', 'communication'] as const)('aborts a held required %s request without automatic SDK retry or false acknowledgement', async stage => {
    held = stage;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 5000 ? 10 : ms));
    expect((await deliver()).status).toBe(503);
    expect(requested).toHaveBeenCalledWith(5000);
    const attempted = calls.filter(call => stage === 'profile' ? call.table === 'guardian_member_profiles' : call.table === 'guardian_communications' && call.method === 'POST');
    expect(attempted).toHaveLength(1); expect(attempted[0].signal?.aborted).toBe(true);
    expect(event?.status).toBe('error'); expect(seam.notify).not.toHaveBeenCalled();
  });
});

describe('actual scope and notification service integration over installed PostgREST', () => {
  it('saves one notification, retains read/delivery markers and does not recreate it on sequential retry', async () => {
    await useRealNotifications(); lostNotification = true;
    expect((await deliver()).status).toBe(503); expect(notifications).toHaveLength(1); expect(event?.status).toBe('error');
    notifications[0].is_read = true; notifications[0].sent_at = '2026-09-12T10:00:00Z'; notifications[0].pushed_at = '2026-09-12T10:00:01Z';
    const saved = { ...notifications[0] };
    lostNotification = false;
    expect((await deliver()).status).toBe(200); expect(event?.status).toBe('processed');
    expect(notifications).toEqual([saved]); expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.scam).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'notifications' && call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.table === 'notifications' && call.method === 'GET').every(call => !call.url.searchParams.has('is_read'))).toBe(true);
  });
  it.each(['scope', 'notification-read'] as const)('does not acknowledge an actual required %s read failure and recovers from saved communication', async stage => {
    await useRealNotifications(); failure = stage;
    expect((await deliver()).status).toBe(503); expect(notifications).toEqual([]); expect(communication).toMatchObject({ id: COMM });
    failure = null;
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1); expect(seam.pipeline).toHaveBeenCalledOnce();
  });
  it('preserves real quiet-hour scheduling for a routine saved text', async () => {
    await useRealNotifications();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-12T23:00:00Z'));
    quietHours = { family_id: FAMILY, quiet_hours_start: 22, quiet_hours_end: 7 };
    expect((await deliver()).status).toBe(200);
    expect(notifications).toHaveLength(1); expect(notifications[0].send_at).toBe('2026-09-13T07:00:00.000Z');
    expect(notifications[0].related_id).toBe(COMM);
  });
});
