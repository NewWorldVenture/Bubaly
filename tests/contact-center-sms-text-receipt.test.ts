import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { prepareSmsReply, readSmsReply, attachSmsReply, reserveSmsReply, validateSmsReplyReceipt,
  smsReplyOutboundId, smsReplyOutboundRef, SmsReplyUnavailableError, type SmsReplyBinding, type SmsReplyCandidate } from '@/lib/contact-center/sms-reply';

const FAMILY = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const INBOUND = '33333333-3333-4333-8333-333333333333', NOW = '2026-09-12T12:00:00.000Z';
const BINDING: SmsReplyBinding = { familyId: FAMILY, channelId: FAMILY, smsSid: `SM${'a'.repeat(32)}`,
  from: '+15555550200', to: '+15555550100', body: 'Synthetic appointment note' };
const CANDIDATE: SmsReplyCandidate = { summary: 'A note', intent: 'appointment', reply: 'First committed reply & <notes>', locale: 'en-US', suppression: null };
type Row = Record<string, unknown>;
type Call = { table: string; method: string; url: URL; body: Row | null; signal: AbortSignal | null | undefined };
const clone = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function matches(row: Row, url: URL): boolean {
  return [...url.searchParams].every(([key, filter]) => {
    const [column, path] = key.split('->>');
    const value = path ? (row[column] as Row)?.[path] : row[key];
    if (filter.startsWith('eq.')) {
      const wanted = filter.slice(3);
      if (typeof value === 'object' && value !== null) return equal(value, JSON.parse(wanted));
      return String(value) === wanted;
    }
    if (filter === 'is.null') return value === null;
    return true;
  });
}
function fixture() {
  const state = {
    tables: { ai_tool_calls: [], family_inbox_messages: [], family_contact_channels: [{ family_id: FAMILY, phone_number: BINDING.to, ai_concierge_enabled: true }] } as Record<string, Row[]>,
    calls: [] as Call[], before: undefined as ((call: Call) => void | Promise<void>) | undefined,
    after: undefined as ((call: Call, rows: Row[]) => void | Promise<void>) | undefined,
    fail: '' as string, response: undefined as ((call: Call, rows: Row[]) => unknown) | undefined,
    count: undefined as ((call: Call, count: number) => number | null) | undefined,
  };
  const client = createClient<Database>('https://sms-reply-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').pop()!;
      if (!(table in state.tables)) throw new Error('Unexpected fixture table');
      const call: Call = { table, method: init.method ?? 'GET', url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal };
      state.calls.push(call); await state.before?.(call);
      if (state.fail === `${call.method}:${table}`) return Response.json({ code: '42501', message: 'Synthetic unavailable' }, { status: 403 });
      let found: Row[];
      if (call.method === 'POST') {
        const body = clone(call.body!);
        if (state.tables[table].some(row => row.id === body.id || table === 'ai_tool_calls' && row.family_id === body.family_id && row.idempotency_key === body.idempotency_key
          || table === 'family_inbox_messages' && body.provider_ref && row.channel === body.channel && row.provider_ref === body.provider_ref)) {
          return Response.json({ code: '23505', message: 'Synthetic unique conflict' }, { status: 409 });
        }
        const saved = { ...(table === 'family_inbox_messages' ? { occurred_at: NOW } : {}), created_at: NOW, updated_at: NOW, ...body };
        state.tables[table].push(saved); found = [saved];
      } else {
        found = state.tables[table].filter(row => matches(row, url));
        if (call.method === 'PATCH') for (const row of found) Object.assign(row, clone(call.body));
        else if (call.method !== 'GET') throw new Error('Unexpected fixture method');
      }
      await state.after?.(call, found);
      const count = state.count ? state.count(call, found.length) : found.length;
      const result = state.response ? state.response(call, found) : clone(found);
      return Response.json(result, { status: call.method === 'POST' ? 201 : 200,
        headers: count === null ? {} : { 'content-range': `0-${Math.max(0, found.length - 1)}/${count}` } });
    } },
  });
  return { client, state };
}
type Fixture = ReturnType<typeof fixture>;
function addInbound(f: Fixture, binding = BINDING, changes: Row = {}) {
  const row = { id: INBOUND, family_id: binding.familyId, channel: 'sms', direction: 'inbound', from_addr: binding.from, to_addr: binding.to,
    body: binding.body, subject: null, ai_summary: CANDIDATE.summary, ai_intent: CANDIDATE.intent, ai_handled: false, status: 'new', provider_ref: binding.smsSid, occurred_at: NOW, ...changes };
  f.state.tables.family_inbox_messages.push(row); return row;
}
async function attached(candidate = CANDIDATE) {
  const f = fixture(), receipt = await prepareSmsReply(f.client, BINDING, async () => candidate);
  addInbound(f);
  return { ...f, receipt: await attachSmsReply(f.client, receipt, INBOUND) };
}
const unavailable = (promise: Promise<unknown>) => expect(promise).rejects.toEqual(new SmsReplyUnavailableError());
const raw = (f: Fixture) => f.state.tables.ai_tool_calls[0];
afterEach(() => vi.restoreAllMocks());

import { createHash } from 'node:crypto';
import { recordSmsReplyDelivery, type SmsReplyReceipt } from '@/lib/contact-center/sms-reply';

function changeFrozenReply(f: Fixture, reply: string): SmsReplyReceipt {
  const row = raw(f), inputs = row.inputs as Row;
  const candidate = { ...(inputs.candidate as Row), reply };
  row.inputs = { ...inputs, candidate, fingerprint: createHash('sha256').update(JSON.stringify({ binding: inputs.binding, candidate })).digest('hex') };
  const outbound = f.state.tables.family_inbox_messages.find(message => message.direction === 'outbound');
  if (outbound) outbound.body = reply;
  return validateSmsReplyReceipt(row);
}
async function oldQueued(reply = 'x'.repeat(1600), withProjection = false) {
  const f = await attached();
  if (withProjection) {
    f.state.tables.family_inbox_messages.push({ id: smsReplyOutboundId(f.receipt.id), family_id: FAMILY, channel: 'sms', direction: 'outbound',
      from_addr: BINDING.to, to_addr: BINDING.from, subject: null, body: CANDIDATE.reply, ai_summary: null, ai_intent: null, ai_handled: true,
      status: 'archived', provider_ref: smsReplyOutboundRef(f.receipt.id), occurred_at: NOW, created_at: NOW, updated_at: NOW });
  }
  return { ...f, receipt: changeFrozenReply(f, reply) };
}

describe('SMS receipt text boundaries with installed PostgREST', () => {
  it.each([null, [], {}, { ...CANDIDATE, reply: 12 }, { ...CANDIDATE, summary: null },
    { ...CANDIDATE, reply: '' }, { ...CANDIDATE, reply: '  ' }, { ...CANDIDATE, extra: true },
    { ...CANDIDATE, locale: 'x'.repeat(41) }, { ...CANDIDATE, intent: 'invalid' }])
    ('keeps malformed candidate shapes and nontext fields invalid: %j', async candidate => {
      const f = fixture();
      await unavailable(prepareSmsReply(f.client, BINDING, vi.fn().mockResolvedValue(candidate)));
      expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
    });

  it('keeps oversized inbound bindings invalid rather than silently changing their identity', async () => {
    const f = fixture();
    await unavailable(prepareSmsReply(f.client, { ...BINDING, body: 'a'.repeat(4097) }, async () => CANDIDATE));
    expect(f.state.calls).toEqual([]);
  });

  it.each([1599, 1600, 4096, 5000])('bounds only a new %i-unit reply before immutable storage', async length => {
    const f = fixture(), reply = 'x'.repeat(length);
    const receipt = await prepareSmsReply(f.client, BINDING, async () => ({ ...CANDIDATE, reply }));
    expect(receipt.candidate.reply).toBe(reply.slice(0, 1599));
    expect(validateSmsReplyReceipt(raw(f))).toEqual(receipt);
    const saved = clone(raw(f));
    expect(await prepareSmsReply(f.client, BINDING, async () => { throw new Error('Must not regenerate'); })).toEqual(receipt);
    expect(raw(f)).toEqual(saved);
  });

  it('normalizes new summaries/replies before schema and fingerprint without changing valid PostgreSQL controls', async () => {
    const f = fixture();
    const receipt = await prepareSmsReply(f.client, BINDING, async () => ({ ...CANDIDATE,
      summary: 'a\u0000\ud800\u0001b', reply: 'a\u0000\udc00\u0001\ufffeb' }));
    expect(receipt.candidate.summary).toBe('a\ufffd\ufffd\u0001b');
    expect(receipt.candidate.reply).toBe('a\ufffd\ufffd\ufffd\ufffdb');
    expect(validateSmsReplyReceipt(raw(f))).toEqual(receipt);
  });

  it('keeps complete pairs at new summary and reply storage boundaries', async () => {
    const f = fixture();
    const receipt = await prepareSmsReply(f.client, BINDING, async () => ({ ...CANDIDATE,
      summary: 'a'.repeat(999) + '\u{1f600}', reply: 'b'.repeat(1598) + '\u{1f600}' }));
    expect(receipt.candidate.summary).toBe('a'.repeat(999));
    expect(receipt.candidate.reply).toBe('b'.repeat(1598));
  });

  it.each([false, true])('suppresses an old oversized queued reply without changing its candidate/projection (projection=%j)', async withProjection => {
    const f = await oldQueued(undefined, withProjection), inputs = clone(raw(f).inputs), inbox = clone(f.state.tables.family_inbox_messages);
    f.state.calls.length = 0;
    const result = await reserveSmsReply(f.client, f.receipt);
    expect(result).toMatchObject({ emission: null, receipt: { phase: 'suppressed', reason: 'unsupported_content', emissionToken: null, outboundId: null } });
    expect(raw(f)).toMatchObject({ inputs, state: 'failed', attempt: 0, resource_id: INBOUND });
    expect(f.state.tables.family_inbox_messages).toEqual(inbox);
    expect(f.state.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
    const saved = clone(raw(f));
    expect(await reserveSmsReply(f.client, result.receipt)).toEqual({ receipt: result.receipt, emission: null });
    expect(raw(f)).toEqual(saved);
  });

  it('emits an existing valid 1599-unit queued candidate byte-exact and only once', async () => {
    const f = await oldQueued('a'.repeat(1597) + '\u{1f600}'), inputs = clone(raw(f).inputs);
    const result = await reserveSmsReply(f.client, f.receipt);
    expect(result.emission).toBe(f.receipt.candidate.reply); expect(raw(f).inputs).toEqual(inputs);
    const saved = clone(raw(f));
    expect((await reserveSmsReply(f.client, result.receipt)).emission).toBeNull(); expect(raw(f)).toEqual(saved);
  });

  it('does not reopen or rewrite an already-reserved oversized historical reply or its delivery', async () => {
    const f = await attached(); await reserveSmsReply(f.client, f.receipt);
    const receipt = changeFrozenReply(f, 'x'.repeat(2000));
    await recordSmsReplyDelivery(f.client, { receiptId: receipt.id, emissionToken: receipt.emissionToken!, providerSid: `SM${'b'.repeat(32)}`, status: 'delivered' });
    const before = clone(f.state.tables);
    const current = await readSmsReply(f.client, BINDING);
    expect(current).toMatchObject({ delivery: { status: 'delivered' } });
    expect((await reserveSmsReply(f.client, current!)).emission).toBeNull();
    expect(await prepareSmsReply(f.client, BINDING, async () => { throw new Error('Must not regenerate'); })).toEqual(current);
    expect(f.state.tables).toEqual(before);
  });

  it('uses a scalar-safe fallback only for a new legacy receipt with a missing summary', async () => {
    const f = fixture(), binding = { ...BINDING, body: 'a'.repeat(999) + '\u{1f600}' };
    addInbound(f, binding, { ai_summary: null, ai_intent: null });
    const receipt = await prepareSmsReply(f.client, binding, async () => { throw new Error('Legacy never runs AI'); });
    expect(receipt).toMatchObject({ phase: 'legacy_unknown', candidate: { summary: 'a'.repeat(999), reply: null } });
    const before = clone(f.state.tables);
    expect(await prepareSmsReply(f.client, binding, async () => CANDIDATE)).toEqual(receipt);
    expect((await reserveSmsReply(f.client, receipt)).emission).toBeNull(); expect(f.state.tables).toEqual(before);
  });

  it('keeps an existing valid legacy snapshot and an ordinary stored control byte-exact', async () => {
    const f = fixture(), binding = { ...BINDING, body: 'Stored\u0001text' };
    addInbound(f, binding, { ai_summary: 'Original\u000bsummary', ai_intent: 'personal', status: 'archived' });
    const receipt = await prepareSmsReply(f.client, binding, async () => CANDIDATE), saved = clone(f.state.tables);
    expect(receipt.candidate.summary).toBe('Original\u000bsummary');
    expect(await prepareSmsReply(f.client, binding, async () => { throw new Error('Do not reinterpret'); })).toEqual(receipt);
    expect((await reserveSmsReply(f.client, receipt)).emission).toBeNull(); expect(f.state.tables).toEqual(saved);
  });

  it('reconciles a committed-but-lost suppression without granting emission', async () => {
    const f = await oldQueued();
    f.state.after = call => { if (call.method === 'PATCH') throw new Error('Synthetic lost commit reply'); };
    const result = await reserveSmsReply(f.client, f.receipt);
    expect(result).toMatchObject({ emission: null, receipt: { phase: 'suppressed', reason: 'unsupported_content' } });
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
  });

  it('keeps an oversized queued receipt held when the suppression CAS loses', async () => {
    const f = await oldQueued(), inputs = clone(raw(f).inputs);
    f.state.before = call => { if (call.method === 'PATCH') (raw(f).outputs as Row).revision = OTHER; };
    await unavailable(reserveSmsReply(f.client, f.receipt));
    expect(raw(f)).toMatchObject({ inputs, attempt: 0, outputs: { phase: 'queued', emissionToken: null } });
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
    f.state.before = undefined;
    expect((await reserveSmsReply(f.client, f.receipt)).receipt.phase).toBe('suppressed');
  });

  it('holds on failed suppression storage and retries without projecting or emitting', async () => {
    const f = await oldQueued(); f.state.fail = 'PATCH:ai_tool_calls';
    await unavailable(reserveSmsReply(f.client, f.receipt));
    expect((raw(f).outputs as Row).phase).toBe('queued'); expect(f.state.tables.family_inbox_messages).toHaveLength(1);
    f.state.fail = '';
    expect(await reserveSmsReply(f.client, f.receipt)).toMatchObject({ emission: null, receipt: { phase: 'suppressed' } });
  });

  it('allows overlapping suppression attempts to converge without any emission', async () => {
    const f = await oldQueued();
    const results = await Promise.all([reserveSmsReply(f.client, f.receipt), reserveSmsReply(f.client, f.receipt)]);
    expect(results.every(result => result.emission === null && result.receipt.phase === 'suppressed')).toBe(true);
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
  });

  it('keeps invalid XML in a preexisting stored receipt invalid instead of repairing its fingerprint', async () => {
    const f = await attached(), inputs = raw(f).inputs as Row;
    const candidate = { ...(inputs.candidate as Row), reply: '\u0001' };
    raw(f).inputs = { ...inputs, candidate, fingerprint: createHash('sha256').update(JSON.stringify({ binding: inputs.binding, candidate })).digest('hex') };
    await unavailable(readSmsReply(f.client, BINDING));
  });
});
