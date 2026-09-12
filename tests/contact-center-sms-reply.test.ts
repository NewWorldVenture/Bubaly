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

describe('SMS automatic reply authority with installed PostgREST', () => {
  it('persists the first candidate before intake and never regenerates it on replay', async () => {
    const f = fixture(), factory = vi.fn(async () => CANDIDATE);
    const receipt = await prepareSmsReply(f.client, BINDING, factory);
    expect(receipt).toMatchObject({ phase: 'queued', inboundId: null, candidate: CANDIDATE });
    expect(f.state.tables.family_inbox_messages).toEqual([]);
    expect(await prepareSmsReply(f.client, BINDING, async () => { throw new Error('Must not reclassify'); })).toEqual(receipt);
    expect(factory).toHaveBeenCalledOnce(); expect(f.state.tables.ai_tool_calls).toHaveLength(1);
    expect(f.state.calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
  });

  it('chooses the first committed candidate when classifiers race', async () => {
    const f = fixture(); let release!: () => void;
    const slowFactory = vi.fn(() => new Promise<SmsReplyCandidate>(resolve => { release = () => resolve({ ...CANDIDATE, reply: 'Losing reply' }); }));
    const slow = prepareSmsReply(f.client, BINDING, slowFactory);
    await vi.waitFor(() => expect(slowFactory).toHaveBeenCalledOnce());
    const winner = await prepareSmsReply(f.client, BINDING, async () => CANDIDATE);
    release(); expect(await slow).toEqual(winner); expect(f.state.tables.ai_tool_calls).toHaveLength(1);
  });

  it('permits only one emission for simultaneous reservation attempts and all later replays', async () => {
    const f = await attached();
    const results = await Promise.all([reserveSmsReply(f.client, f.receipt), reserveSmsReply(f.client, f.receipt)]);
    expect(results.filter(result => result.emission !== null).map(result => result.emission)).toEqual([CANDIDATE.reply]);
    const saved = await readSmsReply(f.client, BINDING);
    expect(saved).toMatchObject({ phase: 'emission_reserved', inboundId: INBOUND, outboundId: smsReplyOutboundId(f.receipt.id) });
    expect(await reserveSmsReply(f.client, f.receipt)).toMatchObject({ emission: null });
    expect(f.state.tables.family_inbox_messages.filter(row => row.direction === 'outbound')).toHaveLength(1);
  });

  it('resolves an actual unique insert collision to the first committed candidate', async () => {
    const f = fixture(); let waiting = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.state.before = call => {
      if (call.table !== 'ai_tool_calls' || call.method !== 'POST') return;
      waiting++; if (waiting === 2) release(); return gate;
    };
    const results = await Promise.all([
      prepareSmsReply(f.client, BINDING, async () => CANDIDATE),
      prepareSmsReply(f.client, BINDING, async () => ({ ...CANDIDATE, reply: 'Second candidate' })),
    ]);
    expect(results[0]).toEqual(results[1]); expect(f.state.tables.ai_tool_calls).toHaveLength(1);
    expect(f.state.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });

  it('makes the successful reservation CAS the last operation before returning emission', async () => {
    const f = await attached(); f.state.calls.length = 0;
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBe(CANDIDATE.reply);
    const last = f.state.calls.at(-1)!;
    expect(last).toMatchObject({ table: 'ai_tool_calls', method: 'PATCH', body: { attempt: 1, outputs: { phase: 'emission_reserved' } } });
    expect(last.url.searchParams.get('inputs->>fingerprint')).toMatch(/^eq\.[0-9a-f]{64}$/);
    expect(last.url.toString()).not.toContain('%5Bobject+Object%5D');
  });

  it('holds a committed reservation when its response is lost; no readback authorizes emission', async () => {
    const f = await attached();
    f.state.after = call => { if (call.method === 'PATCH' && (call.body?.outputs as Row)?.phase === 'emission_reserved') throw new Error('Synthetic committed response loss'); };
    await unavailable(reserveSmsReply(f.client, f.receipt));
    expect((raw(f).outputs as Row).phase).toBe('emission_reserved');
    f.state.after = undefined;
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it('accepts PostgreSQL timestamp normalization without weakening reservation ownership', async () => {
    const f = await attached();
    f.state.after = (call, found) => {
      if (call.method === 'PATCH' && (call.body?.outputs as Row)?.phase === 'emission_reserved') {
        for (const row of found) row.locked_at = String(row.locked_at).replace('Z', '+00:00');
      }
    };
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBe(CANDIDATE.reply);
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it.each([null, [], [{ id: OTHER }]])('does not emit from an unusable reservation response %j', async response => {
    const f = await attached();
    f.state.response = (call, found) => call.method === 'PATCH' && (call.body?.outputs as Row)?.phase === 'emission_reserved' ? response : clone(found);
    await unavailable(reserveSmsReply(f.client, f.receipt));
    f.state.response = undefined;
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it('does not emit when an exact CAS loses to another revision', async () => {
    const f = await attached();
    f.state.before = call => {
      if (call.method === 'PATCH' && (call.body?.outputs as Row)?.phase === 'emission_reserved') (raw(f).outputs as Row).revision = OTHER;
    };
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
    expect((raw(f).outputs as Row).phase).toBe('queued');
  });

  it('recovers a lost candidate insert response through the actual saved winner', async () => {
    const f = fixture();
    f.state.after = call => { if (call.table === 'ai_tool_calls' && call.method === 'POST') throw new Error('Synthetic lost candidate response'); };
    expect(await prepareSmsReply(f.client, BINDING, async () => CANDIDATE)).toMatchObject({ phase: 'queued', candidate: CANDIDATE });
    expect(f.state.tables.ai_tool_calls).toHaveLength(1);
  });

  it.each([false, true])('holds preexisting inbound messages with ai_handled=%s without calling AI', async handled => {
    const f = fixture(); addInbound(f, BINDING, { ai_handled: handled });
    const factory = vi.fn(async () => CANDIDATE);
    const receipt = await prepareSmsReply(f.client, BINDING, factory);
    expect(receipt).toMatchObject({ phase: 'legacy_unknown', inboundId: INBOUND, candidate: { reply: null, locale: 'und' } });
    expect(factory).not.toHaveBeenCalled(); expect((await reserveSmsReply(f.client, receipt)).emission).toBeNull();
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
  });

  it('refuses unknown intake appearing while the candidate is generated', async () => {
    const f = fixture();
    await unavailable(prepareSmsReply(f.client, BINDING, async () => { addInbound(f); return CANDIDATE; }));
    expect(f.state.tables.ai_tool_calls).toEqual([]);
  });

  it.each(['family_id', 'direction', 'from_addr', 'to_addr', 'body', 'subject'])('refuses a mismatched preexisting inbound %s before AI', async key => {
    const f = fixture(); addInbound(f, BINDING, { [key]: 'other' }); const factory = vi.fn(async () => CANDIDATE);
    await unavailable(prepareSmsReply(f.client, BINDING, factory)); expect(factory).not.toHaveBeenCalled();
    expect(f.state.tables.ai_tool_calls).toEqual([]);
  });

  it('verifies exact persisted inbound binding before attaching its identity', async () => {
    const f = fixture(), receipt = await prepareSmsReply(f.client, BINDING, async () => CANDIDATE);
    addInbound(f, BINDING, { body: 'different' });
    await unavailable(attachSmsReply(f.client, receipt, INBOUND)); expect((raw(f).outputs as Row).inboundId).toBeNull();
  });

  it('recovers lost attachment writes without granting emission', async () => {
    const f = fixture(), receipt = await prepareSmsReply(f.client, BINDING, async () => CANDIDATE); addInbound(f);
    f.state.after = call => { if (call.method === 'PATCH') throw new Error('Synthetic lost attachment response'); };
    expect(await attachSmsReply(f.client, receipt, INBOUND)).toMatchObject({ inboundId: INBOUND, phase: 'queued' });
  });

  it.each(['disabled', 'reassigned', 'missing'])('suppresses a %s current destination without an outbound projection', async change => {
    const f = await attached();
    if (change === 'disabled') f.state.tables.family_contact_channels[0].ai_concierge_enabled = false;
    if (change === 'reassigned') f.state.tables.family_contact_channels[0].family_id = OTHER;
    if (change === 'missing') f.state.tables.family_contact_channels = [];
    const result = await reserveSmsReply(f.client, f.receipt);
    expect(result).toMatchObject({ emission: null, receipt: { phase: 'suppressed', reason: change === 'disabled' ? 'disabled' : 'reassigned' } });
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
  });

  it('rechecks current destination after preparing the projection', async () => {
    const f = await attached();
    f.state.after = call => { if (call.table === 'family_inbox_messages' && call.method === 'POST') f.state.tables.family_contact_channels[0].family_id = OTHER; };
    expect(await reserveSmsReply(f.client, f.receipt)).toMatchObject({ emission: null, receipt: { phase: 'suppressed', reason: 'reassigned' } });
  });

  it.each(['disabled', 'spam', 'unsupported_recipient'] as const)('never reactivates a committed %s candidate', async reason => {
    const f = await attached({ ...CANDIDATE, intent: reason === 'spam' ? 'spam' : CANDIDATE.intent, reply: null, suppression: reason });
    expect(await prepareSmsReply(f.client, BINDING, async () => CANDIDATE)).toMatchObject({ phase: 'suppressed', candidate: { reply: null } });
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull(); expect(f.state.tables.family_inbox_messages).toHaveLength(1);
  });

  it('suppresses a missing sender even if a candidate incorrectly requests a reply', async () => {
    const f = fixture(), binding = { ...BINDING, from: null };
    const receipt = await prepareSmsReply(f.client, binding, async () => CANDIDATE); addInbound(f, binding);
    const attachedReceipt = await attachSmsReply(f.client, receipt, INBOUND);
    expect((await reserveSmsReply(f.client, attachedReceipt)).emission).toBeNull();
    expect(receipt).toMatchObject({ phase: 'suppressed', candidate: { reply: null, suppression: 'unsupported_recipient' } });
  });

  it('preserves read/archive markers and content on an existing verified projection', async () => {
    const f = await attached();
    f.state.fail = 'PATCH:ai_tool_calls'; await unavailable(reserveSmsReply(f.client, f.receipt));
    const projection = f.state.tables.family_inbox_messages.find(row => row.direction === 'outbound')!;
    expect(projection.provider_ref).toBe(smsReplyOutboundRef(f.receipt.id)); projection.status = 'archived';
    const before = clone(projection); f.state.fail = '';
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBe(CANDIDATE.reply);
    expect(projection).toEqual(before);
    expect(f.state.calls.filter(call => call.method === 'POST' && call.table === 'family_inbox_messages')).toHaveLength(1);
  });

  it('refuses an altered projection instead of overwriting it', async () => {
    const f = await attached(); f.state.fail = 'PATCH:ai_tool_calls'; await unavailable(reserveSmsReply(f.client, f.receipt));
    f.state.fail = ''; const projection = f.state.tables.family_inbox_messages.find(row => row.direction === 'outbound')!; projection.body = 'forged';
    await unavailable(reserveSmsReply(f.client, f.receipt)); expect(projection.body).toBe('forged');
  });

  it.each(['id', 'family_id', 'tool_name', 'actor_kind', 'requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id', 'conversation_id', 'message_id', 'resource_table', 'resource_id', 'state', 'attempt', 'locked_at', 'duration_ms', 'error', 'finished_at', 'created_at', 'updated_at', 'idempotency_key'])('rejects tampered private metadata %s before effects', async key => {
    const f = await attached(); raw(f)[key] = key === 'id' ? OTHER : 'tampered'; f.state.calls.length = 0;
    if (key === 'id') expect(() => validateSmsReplyReceipt(raw(f))).toThrow(SmsReplyUnavailableError);
    else await unavailable(reserveSmsReply(f.client, f.receipt));
    expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each(['reply', 'summary', 'intent', 'locale', 'suppression'])('rejects altered immutable candidate %s', async key => {
    const f = await attached(); ((raw(f).inputs as Row).candidate as Row)[key] = 'altered';
    await unavailable(readSmsReply(f.client, BINDING));
  });

  it.each(['\u0000', '\u000b', '\ud800', '\ufffe'])('repairs newly generated XML-invalid reply %j before freezing it', async reply => {
    const f = fixture(), receipt = await prepareSmsReply(f.client, BINDING, async () => ({ ...CANDIDATE, reply }));
    expect(receipt.candidate.reply).toBe('\ufffd');
    expect(validateSmsReplyReceipt(raw(f))).toEqual(receipt);
  });

  it.each([null, 2])('rejects missing or cap-hidden count %s', async count => {
    const f = fixture(); f.state.count = () => count;
    await unavailable(prepareSmsReply(f.client, BINDING, async () => CANDIDATE)); expect(f.state.tables.ai_tool_calls).toEqual([]);
  });

  it('bounds large frozen text without putting the entire body in the reservation URL', async () => {
    const f = fixture(), binding = { ...BINDING, body: '家'.repeat(4096) };
    const receipt = await prepareSmsReply(f.client, binding, async () => CANDIDATE); addInbound(f, binding);
    const attachedReceipt = await attachSmsReply(f.client, receipt, INBOUND);
    expect((await reserveSmsReply(f.client, attachedReceipt)).emission).toBe(CANDIDATE.reply);
    expect(f.state.calls.filter(call => call.method === 'PATCH').every(call => call.url.toString().length < 4000)).toBe(true);
  });

  it('ignores a classifier that completes after caller cancellation', async () => {
    const f = fixture(), controller = new AbortController(); let release!: () => void;
    const factory = vi.fn(() => new Promise<SmsReplyCandidate>(resolve => { release = () => resolve(CANDIDATE); }));
    const result = prepareSmsReply(f.client, BINDING, factory, { signal: controller.signal });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce()); controller.abort(); await unavailable(result);
    const count = f.state.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.state.calls).toHaveLength(count); expect(f.state.tables.ai_tool_calls).toEqual([]);
  });

  it('cannot emit from a CAS that commits after an ignored abort', async () => {
    const f = await attached(), controller = new AbortController(); let release!: () => void;
    f.state.before = call => call.method === 'PATCH' && (call.body?.outputs as Row)?.phase === 'emission_reserved'
      ? new Promise<void>(resolve => { release = resolve; }) : undefined;
    const result = reserveSmsReply(f.client, f.receipt, { signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort(); await unavailable(result);
    release(); await new Promise(resolve => setTimeout(resolve, 10)); f.state.before = undefined;
    expect((raw(f).outputs as Row).phase).toBe('emission_reserved');
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it('cannot reach AI or writes after an initial ledger read ignores cancellation', async () => {
    const f = fixture(), controller = new AbortController(); let release!: () => void;
    const factory = vi.fn(async () => CANDIDATE);
    f.state.before = () => new Promise<void>(resolve => { release = resolve; });
    const result = prepareSmsReply(f.client, BINDING, factory, { signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort(); await unavailable(result);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(factory).not.toHaveBeenCalled(); expect(f.state.calls).toHaveLength(1); expect(f.state.tables.ai_tool_calls).toEqual([]);
  });
});
