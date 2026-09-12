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
let calls: Call[] = [], failure: 'claim' | 'profile' | 'communication' | 'decision' | 'saved-read' | 'lease-read' | 'finish' | 'release' | 'notification-read' | 'scope' | null = null;
let event: Row | null = null;
let communication: Row | null = null;
let profiles: Row[], notifications: Row[], quietHours: Row | null;
let policyFailure: 'contact' | 'profile' | 'rules' | null = null;
let lostCommunication = false, nullCommunicationReceipt = false, lostNotification = false, profileCount: number | null | undefined;
let lostDecision = false, nullDecisionReceipt = false, emptyDecisionReceipt = false, failDecisionRead = false;
let beforeDecisionUpdate: (() => void) | undefined;
let beforeCommunicationRead: (() => void) | undefined;
let held: 'profile' | 'communication' | 'decision' | null = null;
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
  profiles = [{ id: MEMBER, family_id: FAMILY, member_id: MEMBER, guardian_phone: '+15555550100', is_active: true,
    ai_persona_name: 'Synthetic Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked' }];
  policyFailure = null;
  notifications = []; quietHours = null; lostCommunication = false; nullCommunicationReceipt = false; lostNotification = false; profileCount = undefined;
  lostDecision = false; nullDecisionReceipt = false; emptyDecisionReceipt = false; failDecisionRead = false;
  beforeDecisionUpdate = undefined; beforeCommunicationRead = undefined;
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
      if ((held === 'profile' && table === 'guardian_member_profiles')
        || (held === 'communication' && table === 'guardian_communications' && method === 'POST')
        || (held === 'decision' && table === 'guardian_communications' && method === 'PATCH')) {
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
        if (failure === 'lease-read') return error();
        return selected(event && matches(event, url) ? [event] : [], url, init);
      }
      if (table === 'guardian_callback_events' && method === 'PATCH') {
        if ((failure === 'finish' && body?.status === 'processed') || (failure === 'release' && body?.status === 'error')) return error();
        const matched = event && matches(event, url) ? event : null;
        if (matched) Object.assign(matched, body);
        return selected(matched ? [matched] : [], url, init);
      }
      if (table === 'guardian_member_profiles' && method === 'GET') {
        if (failure === 'profile' || (policyFailure === 'profile' && url.searchParams.has('member_id'))) return error();
        const found = profiles.filter(row => matches(row, url));
        return selected(found, url, init, 200, profileCount === undefined ? found.length : profileCount);
      }
      if (table === 'guardian_contacts' && method === 'GET') return policyFailure === 'contact' ? error() : selected([], url, init);
      if (table === 'guardian_routing_rules' && method === 'GET') return policyFailure === 'rules' ? error() : selected([], url, init);
      if (table === 'guardian_communications' && method === 'GET') {
        beforeCommunicationRead?.();
        if (failure === 'saved-read') return error();
        return selected(communication && matches(communication, url) ? [communication] : [], url, init);
      }
      if (table === 'guardian_communications' && method === 'POST') {
        if (failure === 'communication') return error();
        if (communication) return Response.json({ code: '23505', message: 'Synthetic unique SMS SID' }, { status: 409 });
        communication = { ...body, id: body?.id ?? COMM };
        if (lostCommunication) throw new Error('Synthetic lost response after committed message');
        if (nullCommunicationReceipt) return Response.json(null, { status: 201 });
        return selected([{ id: communication.id }], url, init, 201);
      }
      if (table === 'guardian_communications' && method === 'PATCH') {
        beforeDecisionUpdate?.();
        if (failure === 'decision') return error();
        const matched = communication && matches(communication, url) ? communication : null;
        if (matched && !emptyDecisionReceipt) Object.assign(matched, body);
        if (failDecisionRead) failure = 'saved-read';
        if (lostDecision) throw new Error('Synthetic lost response after committed decision');
        if (nullDecisionReceipt) return Response.json(null);
        return selected(matched && !emptyDecisionReceipt ? [{ id: matched.id }] : [], url, init);
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
async function useRealPipeline() {
  const screening = vi.spyOn(await import('@/lib/guardian/scam'), 'detectScamFromText');
  seam.pipeline.mockImplementation((await vi.importActual<typeof import('@/lib/guardian/pipeline')>('@/lib/guardian/pipeline')).runDecisionPipeline);
  return screening;
}

describe('signed SMS retention with the actual decision pipeline and installed policy SDK', () => {
  it.each(['contact', 'profile', 'rules'] as const)('retains pending intake after an actual %s policy read fails, then classifies once on recovery', async stage => {
    const screening = await useRealPipeline();
    policyFailure = stage;
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ family_id: FAMILY, member_id: MEMBER, body: 'Dentist appointment tomorrow', twilio_sms_sid: SID,
      status: 'screening', contact_id: null, from_name: null, trust_level_at_time: null, routing_mode_used: null,
      routing_rule_id: null, ai_decision_reason: null, scam_detected: false, scam_type: null, scam_confidence: null });
    expect(event?.status).toBe('error');
    expect(screening).not.toHaveBeenCalled(); expect(seam.scam).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
    await expect(seam.pipeline.mock.results[0].value).rejects.toMatchObject({ name: 'GuardianPolicyUnavailableError', stage });
    const retainedId = communication?.id;
    const policyReads = calls.filter(call => call.method === 'GET' && (['guardian_contacts', 'guardian_routing_rules'].includes(call.table)
      || call.table === 'guardian_member_profiles' && call.url.searchParams.has('member_id')));
    expect(policyReads).toHaveLength(3);
    expect(policyReads.every(call => call.url.searchParams.get('family_id') === `eq.${FAMILY}` && call.signal instanceof AbortSignal)).toBe(true);
    expect(calls.findIndex(call => call.table === 'guardian_communications' && call.method === 'POST')).toBeLessThan(calls.indexOf(policyReads[0]));

    policyFailure = null;
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ id: retainedId, status: 'received', trust_level_at_time: 'unknown', routing_mode_used: 'voicemail_first' });
    expect(event?.status).toBe('processed');
    expect(screening).toHaveBeenCalledOnce(); expect(seam.scam).toHaveBeenCalledOnce(); expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.pipeline).toHaveBeenCalledTimes(2);
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'PATCH')).toHaveLength(1);
    expect((await deliver()).status).toBe(200);
    expect(seam.pipeline).toHaveBeenCalledTimes(2); expect(screening).toHaveBeenCalledOnce(); expect(seam.notify).toHaveBeenCalledOnce();
  });
  it('treats verified absent contact and rules as healthy and applies the actual member default', async () => {
    const screening = await useRealPipeline();
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ status: 'received', contact_id: null, trust_level_at_time: 'unknown', routing_rule_id: null, routing_mode_used: 'voicemail_first' });
    expect(screening).toHaveBeenCalledOnce(); expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.scam).toHaveBeenCalledOnce(); expect(seam.notify).toHaveBeenCalledOnce();
    for (const table of ['guardian_contacts', 'guardian_routing_rules']) {
      const read = calls.filter(call => call.table === table && call.method === 'GET');
      expect(read).toHaveLength(1); expect(read[0].url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
    }
    expect(event?.status).toBe('processed');
  });
});

describe('actual signed Guardian SMS route through installed PostgREST SDK', () => {
  it.each(['pipeline', 'scam'] as const)('retains neutral screening intake before a %s outage and classifies it on retry', async stage => {
    const target = stage === 'pipeline' ? seam.pipeline : seam.scam;
    target.mockRejectedValueOnce(new Error('Synthetic policy dependency unavailable'));
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ family_id: FAMILY, member_id: MEMBER, body: 'Dentist appointment tomorrow', twilio_sms_sid: SID,
      status: 'screening', contact_id: null, from_name: null, trust_level_at_time: null, routing_mode_used: null,
      routing_rule_id: null, ai_decision_reason: null, scam_detected: false, scam_type: null, scam_confidence: null });
    expect(event?.status).toBe('error'); expect(seam.notify).not.toHaveBeenCalled();
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ status: 'received', routing_mode_used: 'ai_handle_first' });
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
    expect(target).toHaveBeenCalledTimes(2); expect(seam.notify).toHaveBeenCalledOnce();
  });
  it('does not classify a message that required retention storage could not save', async () => {
    failure = 'communication';
    expect((await deliver()).status).toBe(503);
    expect(seam.pipeline).not.toHaveBeenCalled(); expect(seam.scam).not.toHaveBeenCalled();
  });
  it('starts policy work only after the exact owned neutral message has been read back', async () => {
    seam.pipeline.mockImplementation(async () => {
      expect(communication).toMatchObject({ status: 'screening', routing_mode_used: null, ai_decision_reason: null, scam_confidence: null });
      const retained = calls.filter(call => call.table === 'guardian_communications');
      expect(retained.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
      expect(retained[1].body).toMatchObject({ id: communication?.id, body: 'Dentist appointment tomorrow', twilio_sms_sid: SID });
      return { contactId: null, contactName: null, trustLevel: 'known_contact', routingMode: 'ai_handle_first', ruleId: null, reason: 'Synthetic permitted message' };
    });
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledOnce();
  });
  it.each(['id', 'body', 'family_id', 'member_id', 'from_number', 'to_number', 'status', 'ai_decision_reason'])('refuses a changed retained %s before classification', async field => {
    beforeCommunicationRead = () => { if (communication) communication[field] = field === 'id' ? COMM : 'changed after insert'; };
    expect((await deliver()).status).toBe(503);
    expect(seam.pipeline).not.toHaveBeenCalled(); expect(seam.scam).not.toHaveBeenCalled(); expect(seam.notify).not.toHaveBeenCalled();
    expect(event?.status).toBe('error');
  });
  it('retains a saved neutral message when the insert readback fails and recovers it on retry', async () => {
    beforeCommunicationRead = () => { if (communication) failure = 'saved-read'; };
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ status: 'screening', routing_mode_used: null }); expect(seam.pipeline).not.toHaveBeenCalled();
    beforeCommunicationRead = undefined; failure = null;
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it.each(['error', 'empty'] as const)('retains screening after an uncommitted decision %s and recomputes on retry', async mode => {
    if (mode === 'error') failure = 'decision'; else emptyDecisionReceipt = true;
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ status: 'screening', routing_mode_used: null, ai_decision_reason: null });
    expect(seam.notify).not.toHaveBeenCalled(); expect(event?.status).toBe('error');
    failure = null; emptyDecisionReceipt = false;
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledTimes(2); expect(seam.scam).toHaveBeenCalledTimes(2);
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it.each(['lost-response', 'null-receipt'] as const)('reconciles a committed decision %s by exact durable decision readback', async mode => {
    lostDecision = mode === 'lost-response'; nullDecisionReceipt = mode === 'null-receipt';
    expect((await deliver()).status).toBe(200); expect(seam.notify).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'PATCH')).toHaveLength(1);
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.notify).toHaveBeenCalledOnce();
  });
  it('does not notify an unconfirmed committed decision and reuses it after read recovery', async () => {
    failDecisionRead = true;
    expect((await deliver()).status).toBe(503); expect(communication).toMatchObject({ status: 'received' });
    expect(seam.notify).not.toHaveBeenCalled(); expect(event?.status).toBe('error');
    failDecisionRead = false; failure = null;
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.scam).toHaveBeenCalledOnce();
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'PATCH')).toHaveLength(1);
  });
  it.each(['contact_id', 'from_name', 'trust_level_at_time', 'routing_mode_used', 'routing_rule_id', 'ai_decision_reason', 'scam_detected', 'scam_type', 'scam_confidence', 'status', 'from_number', 'to_number', 'family_id', 'member_id', 'id', 'twilio_sms_sid'])('does not overwrite %s changed while classification was pending', async field => {
    const changed = field === 'scam_detected' ? true : field === 'scam_confidence' ? 91 : field === 'status' ? 'handled' : field.endsWith('_id') || field === 'id' ? COMM : 'other worker value';
    beforeDecisionUpdate = () => { if (communication) communication[field] = changed; };
    expect((await deliver()).status).toBe(503); expect(communication?.[field]).toBe(changed);
    expect(communication?.routing_mode_used).toBe(field === 'routing_mode_used' ? changed : null);
    expect(seam.notify).not.toHaveBeenCalled(); expect(event?.status).toBe('error');
  });
  it('suppresses notification if an external body change breaks exact post-decision readback', async () => {
    beforeDecisionUpdate = () => { if (communication) communication.body = 'Changed outside the intake path'; };
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ body: 'Changed outside the intake path', status: 'received' });
    expect(seam.notify).not.toHaveBeenCalled(); expect(event?.status).toBe('error');
  });
  it('retains and classifies an allowed long Unicode message without placing its body in request URLs', async () => {
    const body = '家庭🙂'.repeat(1024);
    expect(body).toHaveLength(4096);
    expect((await deliver(true, { Body: body })).status).toBe(200);
    expect(communication).toMatchObject({ body, status: 'received' });
    expect(seam.scam).toHaveBeenCalledWith(body, '+15555550200', `Family ID: ${FAMILY}`);
    expect(calls.every(call => !call.url.searchParams.has('body') && !decodeURIComponent(call.url.href).includes('家庭'))).toBe(true);
    expect(Math.max(...calls.map(call => call.url.href.length))).toBeLessThan(2000);
  });
  it('does not write a decision after its lease was replaced during AI work', async () => {
    seam.scam.mockImplementation(async () => {
      if (event) event.error = `sms-lease:${NOTIFICATION}`;
      return { isScam: false, scamType: null, confidence: 0 };
    });
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ status: 'screening', routing_mode_used: null });
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'PATCH')).toHaveLength(0);
    expect(event).toMatchObject({ status: 'processing', error: `sms-lease:${NOTIFICATION}` }); expect(seam.notify).not.toHaveBeenCalled();
  });
  it('does not notify after its lease was replaced while resolving notification scope', async () => {
    seam.scope.mockImplementation(async () => {
      if (event) event.error = `sms-lease:${NOTIFICATION}`;
      return { familyId: FAMILY };
    });
    expect((await deliver()).status).toBe(503); expect(communication).toMatchObject({ status: 'received' });
    expect(event).toMatchObject({ status: 'processing', error: `sms-lease:${NOTIFICATION}` }); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['decision', 'notification'] as const)('does not proceed past an unavailable current-lease read before %s', async phase => {
    if (phase === 'decision') failure = 'lease-read';
    else seam.scope.mockImplementation(async () => { failure = 'lease-read'; return { familyId: FAMILY }; });
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ status: phase === 'decision' ? 'screening' : 'received' });
    expect(event?.status).toBe('error'); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['routing_rule_id', 'ai_decision_reason', 'scam_type', 'scam_detected', 'scam_confidence', 'routing_mode_used', 'trust_level_at_time', 'status', 'contact_id', 'from_name'])('does not accept a different valid %s decision as its own write receipt', async field => {
    const changed: Record<string, unknown> = { routing_rule_id: COMM, ai_decision_reason: 'Other decision', scam_type: 'phishing', scam_detected: true,
      scam_confidence: 91, routing_mode_used: 'silent_handling', trust_level_at_time: 'trusted_friend', status: 'handled', contact_id: COMM, from_name: 'Other contact' };
    beforeCommunicationRead = () => {
      if (communication?.status === 'received') communication[field] = changed[field];
    };
    expect((await deliver()).status).toBe(503); expect(seam.notify).not.toHaveBeenCalled(); expect(event?.status).toBe('error');
    expect(communication?.[field]).toBe(changed[field]);
  });
  it('does not replace a competing complete decision and replays that verified decision on a later attempt', async () => {
    beforeDecisionUpdate = () => { if (communication) Object.assign(communication, { status: 'blocked', trust_level_at_time: 'blocked', routing_mode_used: 'blocked',
      ai_decision_reason: 'Other confirmed screening', scam_confidence: 0 }); };
    expect((await deliver()).status).toBe(503); expect(seam.notify).not.toHaveBeenCalled();
    expect(communication).toMatchObject({ status: 'blocked', ai_decision_reason: 'Other confirmed screening' });
    beforeDecisionUpdate = undefined;
    expect((await deliver()).status).toBe(200); expect(seam.pipeline).toHaveBeenCalledOnce(); expect(seam.notify).not.toHaveBeenCalled();
    expect(event?.status).toBe('processed');
  });
  it('retains pending intake without releasing another worker lease after a policy exception', async () => {
    seam.pipeline.mockImplementation(async () => {
      if (event) event.error = `sms-lease:${NOTIFICATION}`;
      throw new Error('Synthetic required policy failure');
    });
    expect((await deliver()).status).toBe(503);
    expect(communication).toMatchObject({ status: 'screening', routing_mode_used: null });
    expect(event).toMatchObject({ status: 'processing', error: `sms-lease:${NOTIFICATION}` }); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['claim', 'profile', 'communication'] as const)('does not acknowledge the inbound message after required %s storage fails', async stage => {
    failure = stage;
    const response = await deliver();
    expect(response.status, JSON.stringify({ stage, acknowledged: response.status, savedCommunication: !!communication, eventStatus: event?.status, notifications: seam.notify.mock.calls.length })).toBe(503);
    expect(event?.status).not.toBe('processed');
    expect(communication).toBeNull(); expect(seam.notify).not.toHaveBeenCalled();
  });
  it('acknowledges one healthy saved message and sends its exact related receipt', async () => {
    expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ id: expect.any(String), family_id: FAMILY, member_id: MEMBER, twilio_sms_sid: SID, direction: 'inbound' });
    expect(event?.status).toBe('processed');
    expect(seam.notify).toHaveBeenCalledExactlyOnceWith({ familyId: FAMILY }, expect.objectContaining({ relatedId: communication?.id, relatedType: 'guardian_communications' }));
    expect(calls.filter(call => call.table === 'guardian_communications' && call.method === 'POST')).toHaveLength(1);
  });
  it('rejects an invalid production signature before creating any database client', async () => {
    expect((await deliver(false)).status).toBe(401);
    expect(seam.factory).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(seam.notify).not.toHaveBeenCalled();
  });
  it.each(['claim', 'profile', 'communication'] as const)('recovers a required %s failure on retry without losing the message', async stage => {
    failure = stage; expect((await deliver()).status).toBe(503);
    failure = null; expect((await deliver()).status).toBe(200);
    expect(communication).toMatchObject({ id: expect.any(String), twilio_sms_sid: SID });
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
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ relatedId: communication?.id, once: true });
  });
  it.each(['family_id', 'member_id', 'to_number', 'from_number', 'body', 'id', 'routing_mode_used', 'scam_confidence', 'routing_rule_id', 'ai_decision_reason', 'scam_type'])('rejects conflicting saved communication %s before replay notification', async field => {
    seam.notify.mockResolvedValue({ ok: false, error: 'Synthetic notification outage' });
    expect((await deliver()).status).toBe(503); expect(communication).not.toBeNull();
    const altered = communication as unknown as Row;
    altered[field] = field === 'scam_confidence' ? 80.5 : ['ai_decision_reason', 'scam_type'].includes(field) ? 17 : 'mismatched';
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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101, '80'])('retains pending intake without persisting invalid classifier confidence %s', async confidence => {
    seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence });
    expect((await deliver()).status).toBe(503); expect(communication).toMatchObject({ status: 'screening', scam_confidence: null }); expect(seam.notify).not.toHaveBeenCalled();
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
    expect(communication).toMatchObject({ id: expect.any(String) });
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
  it.each(['profile', 'communication', 'decision'] as const)('aborts a held required %s request without automatic SDK retry or false acknowledgement', async stage => {
    held = stage;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 5000 ? 10 : ms));
    expect((await deliver()).status).toBe(503);
    expect(requested).toHaveBeenCalledWith(5000);
    const attempted = calls.filter(call => stage === 'profile' ? call.table === 'guardian_member_profiles' : call.table === 'guardian_communications' && call.method === (stage === 'decision' ? 'PATCH' : 'POST'));
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
    expect((await deliver()).status).toBe(503); expect(notifications).toEqual([]); expect(communication).toMatchObject({ id: expect.any(String) });
    failure = null;
    expect((await deliver()).status).toBe(200); expect(notifications).toHaveLength(1); expect(seam.pipeline).toHaveBeenCalledOnce();
  });
  it('preserves real quiet-hour scheduling for a routine saved text', async () => {
    await useRealNotifications();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-12T23:00:00Z'));
    quietHours = { family_id: FAMILY, quiet_hours_start: 22, quiet_hours_end: 7 };
    expect((await deliver()).status).toBe(200);
    expect(notifications).toHaveLength(1); expect(notifications[0].send_at).toBe('2026-09-13T07:00:00.000Z');
    expect(notifications[0].related_id).toBe(communication?.id);
  });
});
