import { createHash, createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
const ORIGIN = 'https://bubaly.example', PATH = '/api/contact-center/sms/status';
const AUTH = 'synthetic-status-signature-token', ACCOUNT = `AC${'c'.repeat(32)}`;
const FAMILY = '11111111-1111-4111-8111-111111111111', INBOUND = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444', OTHER = '55555555-5555-4555-8555-555555555555';
const IN_SID = `SM${'a'.repeat(32)}`, OUT_SID = `SM${'b'.repeat(32)}`, NOW = '2026-09-12T12:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let receiptId: string;
let POST: typeof import('@/app/api/contact-center/sms/status/route').POST;
function fields() { return { MessageSid: OUT_SID, MessageStatus: 'sent', From: '+15555550202', To: '+15555550101', AccountSid: ACCOUNT }; }
function query() { return `?receipt=${receiptId}&token=${TOKEN}`; }
function request(params: Record<string, string> = fields(), options: {
  query?: string; signedQuery?: string; signedParams?: Record<string, string>; signature?: string;
  origin?: string; signedOrigin?: string; headers?: Record<string, string>; body?: BodyInit; path?: string;
} = {}) {
  const search = options.query ?? query(), path = options.path ?? PATH;
  const signed = `${options.signedOrigin ?? ORIGIN}${path}${options.signedQuery ?? search}`
    + Object.keys(options.signedParams ?? params).sort().map(key => key + (options.signedParams ?? params)[key]).join('');
  return new NextRequest(`${options.origin ?? ORIGIN}${path}${search}`, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': options.signature ?? createHmac('sha1', AUTH).update(signed).digest('base64'), ...options.headers,
  }, body: options.body ?? new URLSearchParams(params) });
}
function saved() { return db.table('ai_tool_calls')[0]; }
function output() { return saved().outputs as Record<string, unknown>; }
async function expectEmpty(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/xml');
  expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH); vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT);
  const helper = await import('@/lib/contact-center/sms-reply');
  receiptId = helper.smsReplyReceiptId(FAMILY, IN_SID);
  const binding = { familyId: FAMILY, channelId: FAMILY, smsSid: IN_SID, from: '+15555550101', to: '+15555550202', body: 'Synthetic private intake' };
  const candidate = { summary: 'Synthetic summary', intent: 'other', reply: 'Synthetic frozen reply', locale: 'en-US', suppression: null };
  const outbound = helper.smsReplyOutboundId(receiptId);
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_inbox_messages', [
    { id: INBOUND, family_id: FAMILY, channel: 'sms', direction: 'inbound', from_addr: binding.from, to_addr: binding.to,
      body: binding.body, subject: null, ai_summary: candidate.summary, ai_intent: candidate.intent, ai_handled: true, status: 'new', provider_ref: IN_SID, occurred_at: NOW },
    { id: outbound, family_id: FAMILY, channel: 'sms', direction: 'outbound', from_addr: binding.to, to_addr: binding.from,
      body: candidate.reply, subject: null, ai_summary: null, ai_intent: null, ai_handled: true, status: 'read', provider_ref: helper.smsReplyOutboundRef(receiptId), occurred_at: NOW },
  ]);
  db.seed('ai_tool_calls', [{ id: receiptId, family_id: FAMILY, tool_name: 'contact_center.sms_reply', actor_kind: 'system',
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
    inputs: { version: 1, policyVersion: 1, binding, candidate, fingerprint: hash(JSON.stringify({ binding, candidate })) },
    outputs: { version: 1, revision: OTHER, phase: 'emission_reserved', inboundId: INBOUND, outboundId: outbound,
      emissionToken: TOKEN, emissionReservedAt: NOW, emissionAccountSid: ACCOUNT, reason: null },
    state: 'reserved', attempt: 1, locked_at: NOW, duration_ms: null, error: null, resource_table: 'family_inbox_messages', resource_id: INBOUND,
    idempotency_key: `contact_center.sms_reply:v1:${hash(JSON.stringify([FAMILY, 'sms', IN_SID.toLowerCase()]))}`,
    created_at: NOW, updated_at: NOW, finished_at: null,
  }]);
  helper.validateSmsReplyReceipt(saved());
  mocks.admin.mockReturnValue(db);
  POST = (await import('@/app/api/contact-center/sms/status/route')).POST;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('actual signed Contact Center status route and private receipt helper', () => {
  it.each(['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'])('persists verified %s without emitting a message or changing the inbox', async status => {
    const before = structuredClone(db.table('family_inbox_messages'));
    await expectEmpty(await POST(request({ ...fields(), MessageStatus: status })));
    expect(output().delivery).toMatchObject({ providerSid: OUT_SID, status });
    expect(output().phase).toBe('emission_reserved'); expect(output().emissionToken).toBe(TOKEN);
    expect(db.table('family_inbox_messages')).toEqual(before);
    expect(db.table('ai_tool_calls')).toHaveLength(1);
    expect(db.log.every(call => ['ai_tool_calls', 'family_inbox_messages'].includes(call.table))).toBe(true);
  });

  it('accepts consistent legacy aliases and authenticates future fields including __proto__', async () => {
    const params = Object.assign(Object.create(null), fields(), { SmsSid: OUT_SID, SmsStatus: 'sent', FutureTwilioField: 'a&b<value>' });
    params.__proto__ = 'signed-provider-field';
    await expectEmpty(await POST(request(params)));
    expect(output().delivery).toMatchObject({ status: 'sent' });
  });

  it('accepts legacy aliases alone with omitted optional observations', async () => {
    await expectEmpty(await POST(request({ SmsSid: OUT_SID, SmsStatus: 'delivered' })));
    expect(output().delivery).toMatchObject({ status: 'delivered' });
  });

  it('signs query order and percent encoding exactly without trusting forwarding headers', async () => {
    const encoded = `?%74oken=%34${TOKEN.slice(1)}&receipt=${receiptId}`;
    await expectEmpty(await POST(request(fields(), { query: encoded, origin: 'https://untrusted.example',
      headers: { host: 'untrusted.example', 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http' } })));
  });

  it.each(['test', 'development', 'production'])('requires a signature in %s', async mode => {
    vi.stubEnv('NODE_ENV', mode);
    expect((await POST(request(fields(), { signature: 'invalid' }))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(output().delivery).toBeUndefined();
  });

  it.each(['query', 'future field', 'origin'])('rejects a signature that omits or changes the %s', async part => {
    const params = { ...fields(), FutureField: 'new field' };
    const options = part === 'query' ? { signedQuery: '' } : part === 'future field' ? { signedParams: fields() } : { signedOrigin: 'https://untrusted.example' };
    expect((await POST(request(params, options))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(['missing token', 'duplicate token', 'decoded duplicate', 'foreign key', 'bad uuid'])('rejects ambiguous query: %s', async kind => {
    const search = kind === 'missing token' ? `?receipt=${receiptId}` : kind === 'duplicate token' ? `${query()}&token=${TOKEN}`
      : kind === 'decoded duplicate' ? `${query()}&%74oken=${TOKEN}` : kind === 'foreign key' ? `${query()}&familyId=${FAMILY}` : `?receipt=bad&token=${TOKEN}`;
    expect((await POST(request(fields(), { query: search }))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(['MessageSid', 'MessageStatus', '__proto__'])('rejects a repeated form field %s', async key => {
    const body = new URLSearchParams(fields()); body.append(key, 'one'); body.append(key, 'two');
    expect((await POST(request(fields(), { body }))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('rejects multipart nonstring fields and oversized callback bodies', async () => {
    const body = new FormData(); body.set('MessageSid', new Blob(['fixture']), 'fixture.txt');
    const multipart = new NextRequest(`${ORIGIN}${PATH}${query()}`, { method: 'POST', body });
    expect((await POST(multipart)).status).toBe(400);
    expect((await POST(request(fields(), { body: 'a'.repeat(65537) }))).status).toBe(413);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  const invalidFields: Record<string, string>[] = [
    { SmsSid: `SM${'d'.repeat(32)}` }, { SmsStatus: 'delivered' }, { MessageSid: '' }, { MessageSid: 'not-a-sid' },
    { MessageStatus: '' }, { MessageStatus: 'read' }, { From: 'sender-name' }, { To: '' }, { AccountSid: 'bad' },
  ];
  it.each(invalidFields)('rejects malformed or conflicting identity %j', async patch => {
    expect((await POST(request({ ...fields(), ...patch }))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'token', 'from', 'to', 'account'])('rejects a validly signed but mismatched %s', async field => {
    const params = fields(); let search = query();
    if (field === 'receipt') search = `?receipt=${OTHER}&token=${TOKEN}`;
    if (field === 'token') search = `?receipt=${receiptId}&token=${OTHER}`;
    if (field === 'from') params.From = '+15555550303';
    if (field === 'to') params.To = '+15555550303';
    if (field === 'account') params.AccountSid = `AC${'d'.repeat(32)}`;
    expect((await POST(request(params, { query: search }))).status).toBe(403);
    expect(output().delivery).toBeUndefined();
  });

  it('does not infer an old receipt account snapshot from current configuration', async () => {
    delete output().emissionAccountSid;
    expect((await POST(request())).status).toBe(403);
    expect(output().delivery).toBeUndefined();
  });

  it('accepts the saved signed account snapshot when current configuration omits the account', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    await expectEmpty(await POST(request()));
    expect(output().delivery).toMatchObject({ status: 'sent' });
  });

  it('acknowledges replay and out-of-order callbacks without downgrading or resending', async () => {
    await expectEmpty(await POST(request({ ...fields(), MessageStatus: 'delivered' })));
    const durable = structuredClone(saved());
    for (const status of ['delivered', 'queued', 'sent', 'failed']) await expectEmpty(await POST(request({ ...fields(), MessageStatus: status })));
    expect(saved()).toEqual(durable);
    expect(db.table('family_inbox_messages')).toHaveLength(2);
  });

  it('refuses a second provider SID after the first verified observation', async () => {
    await expectEmpty(await POST(request())); const durable = structuredClone(saved());
    expect((await POST(request({ ...fields(), MessageSid: `SM${'d'.repeat(32)}` }))).status).toBe(403);
    expect(saved()).toEqual(durable);
  });

  it('keeps corrupted receipt failures retryable without private diagnostics', async () => {
    saved().actor_kind = 'parent';
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.text()).toBe('Status temporarily unavailable');
    expect(output().delivery).toBeUndefined();
  });

  it('returns 503 when the service client cannot be created', async () => {
    mocks.admin.mockImplementation(() => { throw new Error('Private storage credential diagnostic'); });
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('Private');
  });

  it.each(['read unavailable', 'write unavailable', 'lost write response'])
    ('handles installed PostgREST transport: %s', async mode => {
      let patches = 0;
      const client = createClient<Database>('https://synthetic-status.invalid', 'synthetic-service-key', {
        auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
          const url = new URL(String(input)), method = init?.method ?? 'GET';
          const table = url.pathname.split('/').at(-1)!;
          expect(['ai_tool_calls', 'family_inbox_messages']).toContain(table);
          expect(init?.signal).toBeTruthy();
          if (mode === 'read unavailable') return Response.json({ code: '08006', message: 'Private read outage' }, { status: 503 });
          const found = db.table(table).filter(row => [...url.searchParams].every(([key, value]) => {
            if (['select', 'limit'].includes(key)) return true;
            const [column, property] = key.split('->>');
            const actual = property ? (row[column] as Record<string, unknown>)?.[property] : row[column];
            if (value.startsWith('is.')) return value === 'is.null' && actual === null;
            expect(value.startsWith('eq.')).toBe(true);
            if (actual !== null && typeof actual === 'object') return isDeepStrictEqual(actual, JSON.parse(value.slice(3)));
            return String(actual) === value.slice(3);
          }));
          if (method === 'PATCH') {
            patches++;
            if (mode === 'lost write response') for (const row of found) Object.assign(row, JSON.parse(String(init?.body)));
            return Response.json({ code: '08006', message: 'Private write outage' }, { status: 503 });
          }
          expect(method).toBe('GET');
          return Response.json(found, { headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` } });
        } },
      });
      mocks.admin.mockReturnValue(client);
      const response = await POST(request());
      if (mode === 'lost write response') {
        await expectEmpty(response); expect(patches).toBe(1);
        expect(output().delivery).toMatchObject({ status: 'sent', providerSid: OUT_SID });
      } else {
        expect(response.status).toBe(503); expect(await response.text()).not.toContain('Private');
        expect(output().delivery).toBeUndefined();
      }
      expect(db.table('family_inbox_messages')).toHaveLength(2);
    });

  it('does not accept delivery while the exact outbound projection is missing', async () => {
    db.table('family_inbox_messages').pop();
    expect((await POST(request())).status).toBe(503);
    expect(output().delivery).toBeUndefined();
  });

  it.each(['', 'https://bubaly.example/path', 'https://bubaly.example?query=1', 'https://user:pass@bubaly.example', 'ftp://bubaly.example'])
    ('rejects unusable configured callback origin %s', async origin => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
      expect((await POST(request())).status).toBe(503);
      expect(mocks.admin).not.toHaveBeenCalled();
    });
});
