// A Guardian callback that asked Twilio to retry has to be retryable.
//
// The voice and WhatsApp routes claim each callback first (guardian_callback_
// events, keyed on the Twilio sid), then answer 503 when the Guardian number
// cannot be looked up or the decision pipeline fails — and each says in its
// own comment that the event must stay unconsumed so Twilio retries it. The
// claim said otherwise. It stayed `processing` with a fresh `received_at`, so
// the retry hit the unique key, could not reclaim it for ten minutes, was
// 'settled', and was acknowledged (WhatsApp 200, voice a hang-up) with nothing
// processed. The 503 asked for a retry; the claim threw the retry away.
//
// This runs both handlers end to end against the in-memory client with signed
// Twilio requests, so the claim, the reclaim predicate, the acknowledgement and
// the release are the real ones. The ledger's "unclaimed retry acknowledgement
// and ten-minute callback reclaim remain unverified" (API-262DB8655008,
// API-90346B8397DA) is what the first four cases pin; the fifth is the defect.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ service: vi.fn(), pipeline: vi.fn(), scam: vi.fn(), notify: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/guardian/pipeline', () => ({ runDecisionPipeline: seam.pipeline }));
vi.mock('@/lib/guardian/scam-ai', () => ({ detectScamWithAI: seam.scam }));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: seam.scope }));
vi.mock('@/lib/guardian/ai-screen', () => ({ buildInitialGreeting: () => 'hello', buildVoicemailPrompt: () => 'leave a message' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const ORIGIN = 'https://guardian-fixture.invalid';
const TOKEN = 'synthetic-signature-token';
const GUARDIAN = '+15555550100';
const CALLER = '+15555550199';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;
const PROFILE = {
  id: MEMBER, family_id: FAMILY, member_id: MEMBER, guardian_phone: GUARDIAN, is_active: true,
  ai_persona_name: 'Guardian', ai_greeting_template: null, current_context: 'normal', voicemail_greeting: null, context_overrides: {},
  default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
  default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
};
const DUPLICATE_NUMBER = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

type Route = {
  name: string;
  path: string;
  type: string;
  sid: string;
  form: Record<string, string>;
  /** The first delivery of a message or call to a number nobody owns. */
  done: (res: Response, body: string) => void;
  /** What a duplicate gets: Twilio must stop, and the family must not be bothered twice. */
  ack: (res: Response, body: string) => void;
};

const ROUTES: Route[] = [
  {
    name: 'WhatsApp', path: '/api/guardian/inbound/whatsapp', type: 'inbound_whatsapp', sid: `SM${'a'.repeat(32)}`,
    form: { SmsSid: `SM${'a'.repeat(32)}`, From: `whatsapp:${CALLER}`, To: `whatsapp:${GUARDIAN}`, Body: 'hello?' },
    done: (res, body) => { expect(res.status).toBe(200); expect(body).toBe(''); },
    ack: (res, body) => { expect(res.status).toBe(200); expect(body).toBe(''); },
  },
  {
    name: 'voice', path: '/api/guardian/inbound/voice', type: 'inbound_voice', sid: `CA${'b'.repeat(32)}`,
    form: { CallSid: `CA${'b'.repeat(32)}`, From: CALLER, To: GUARDIAN, CallStatus: 'ringing' },
    done: (res, body) => { expect(res.status).toBe(200); expect(body).toContain('<Record'); },
    ack: (res, body) => { expect(res.status).toBe(200); expect(body).toContain('<Hangup />'); expect(body).not.toContain('<Record'); },
  },
];

/** What Twilio puts in x-twilio-signature: base64 HMAC-SHA1 over url + sorted params. */
function signed(route: Route, form = route.form): NextRequest {
  const url = `${ORIGIN}${route.path}`;
  const sorted = Object.keys(form).sort().map((k) => `${k}${form[k]}`).join('');
  const signature = createHmac('sha1', TOKEN).update(url + sorted).digest('base64');
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(form).toString(),
  });
}

let db: InMemorySupabase;
let errors: unknown[][];

/**
 * The callback table as 0181 declares it: event_id unique, status defaulting to
 * `processing`, received_at defaulting to now(). The in-memory client's
 * defaults are static values, so the clock default is added at insert time.
 */
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

/**
 * One table answers every call with `error` — RESOLVED, the way PostgREST does,
 * never thrown. Returns a function that heals it, which is how a retry finds
 * the database well again.
 */
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
const profileReads = () => db.log.filter((entry) => entry.table === 'guardian_member_profiles').length;

/**
 * Imported per case, after the env is stubbed: lib/guardian/twilio.ts captures
 * TWILIO_AUTH_TOKEN at module load, so a static import would verify every
 * signature against the token of whichever case loaded it first.
 */
async function handler(route: Route): Promise<(req: NextRequest) => Promise<Response>> {
  if (route.type === 'inbound_voice') return (await import('@/app/api/guardian/inbound/voice/route')).POST;
  return (await import('@/app/api/guardian/inbound/whatsapp/route')).POST;
}

async function deliver(route: Route): Promise<[Response, string]> {
  const res = await (await handler(route))(signed(route));
  return [res, await res.text()];
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('live transport is prohibited in this fixture'); }));
  db = database();
  errors = [];
  seam.service.mockImplementation(() => db);
  seam.pipeline.mockRejectedValue(new Error('the pipeline is not part of these cases'));
  seam.scam.mockResolvedValue({ isScam: false, scamType: null, confidence: 0 });
  seam.scope.mockResolvedValue({ familyId: FAMILY });
  seam.notify.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.each(ROUTES)('the Guardian $name callback', (route) => {
  it('claims a first delivery, processes it, and records the callback as processed', async () => {
    const [res, body] = await deliver(route);
    route.done(res, body);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event_id: route.sid, callback_type: route.type, status: 'processed' });
    expect(events()[0].processed_at).toBeTruthy();
    expect(profileReads()).toBe(1);
  });

  it('acknowledges an exact retry of a processed event without processing it again', async () => {
    await deliver(route);
    const [res, body] = await deliver(route);
    route.ack(res, body);
    expect(profileReads(), 'the second delivery must not even look the number up').toBe(1);
    expect(events()).toHaveLength(1);
    expect(events()[0].status).toBe('processed');
  });

  it('acknowledges a retry while another worker still holds a fresh claim', async () => {
    db.seed('guardian_callback_events', [{ event_id: route.sid, callback_type: route.type, status: 'processing', received_at: new Date(Date.now() - MINUTE).toISOString(), processed_at: null, error: null }]);
    const [res, body] = await deliver(route);
    route.ack(res, body);
    expect(profileReads()).toBe(0);
    expect(events()[0].status, 'the other worker keeps its claim').toBe('processing');
  });

  it('reclaims a claim abandoned for more than ten minutes and processes the event', async () => {
    db.seed('guardian_callback_events', [{ event_id: route.sid, callback_type: route.type, status: 'processing', received_at: new Date(Date.now() - 11 * MINUTE).toISOString(), processed_at: null, error: null }]);
    const [res, body] = await deliver(route);
    route.done(res, body);
    expect(profileReads()).toBe(1);
    expect(events()).toHaveLength(1);
    expect(events()[0].status).toBe('processed');
  });

  it('asks for a retry when the claim itself cannot be written, and touches nothing else', async () => {
    refuse(db, 'guardian_callback_events', { code: '42501', message: 'permission denied for table guardian_callback_events' });
    const [res] = await deliver(route);
    expect(res.status).toBe(503);
    expect(profileReads()).toBe(0);
  });

  it('gives the claim back when the number lookup fails, so the retry it asks for is processed', async () => {
    // The defect. Before this, the second delivery below answered the
    // acknowledgement — a 200, or a hang-up — with nothing processed, because
    // the first attempt's claim was still held: the 503 asked for a retry and
    // the claim threw it away.
    const heal = refuse(db, 'guardian_member_profiles', DUPLICATE_NUMBER);
    const [first] = await deliver(route);
    expect(first.status).toBe(503);
    expect(events(), 'a claim held after asking for a retry is a retry refused').toEqual([]);
    expect(errors.some((args) => /Guardian number lookup failed/.test(String(args[0])))).toBe(true);

    heal();
    const [retry, body] = await deliver(route);
    route.done(retry, body);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event_id: route.sid, status: 'processed' });
  });

  it('gives the claim back when the decision pipeline fails, before anything was written', async () => {
    db.seed('guardian_member_profiles', [PROFILE]);
    seam.pipeline.mockRejectedValue(new Error('policy read failed'));
    const [res, body] = await deliver(route);
    expect(res.status).toBe(503);
    expect(body).toBe('Guardian routing unavailable');
    expect(events()).toEqual([]);
    expect(db.table('guardian_communications'), 'nothing was recorded, so a retry starts clean').toEqual([]);
  });
});

describe('releaseGuardianCallback removes only the row this worker holds', () => {
  const client = () => db as unknown as SupabaseClient;

  it('deletes a processing row of the same type and says so', async () => {
    const { releaseGuardianCallback } = await import('@/lib/guardian/callbacks');
    db.seed('guardian_callback_events', [{ event_id: 'SMheld', callback_type: 'inbound_whatsapp', status: 'processing', received_at: new Date().toISOString() }]);
    await expect(releaseGuardianCallback(client(), 'inbound_whatsapp', 'SMheld')).resolves.toBe(true);
    expect(events()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it.each([
    ['a processed row', { status: 'processed', callback_type: 'inbound_whatsapp' }],
    ['a row of another callback type', { status: 'processing', callback_type: 'inbound_sms' }],
  ])('leaves %s alone and reports it', async (_label, row) => {
    const { releaseGuardianCallback } = await import('@/lib/guardian/callbacks');
    db.seed('guardian_callback_events', [{ event_id: 'SMother', received_at: new Date().toISOString(), ...row }]);
    await expect(releaseGuardianCallback(client(), 'inbound_whatsapp', 'SMother')).resolves.toBe(false);
    expect(events()).toHaveLength(1);
    expect(String(errors[0]?.[0])).toMatch(/could not release inbound_whatsapp SMother; a retry inside ten minutes will be acknowledged/);
  });

  it('reports a refused delete rather than throwing into the route', async () => {
    const { releaseGuardianCallback } = await import('@/lib/guardian/callbacks');
    refuse(db, 'guardian_callback_events', { code: '08006', message: 'connection failure' });
    await expect(releaseGuardianCallback(client(), 'inbound_voice', 'CAlost')).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toMatchObject({ code: '08006' });
  });
});
