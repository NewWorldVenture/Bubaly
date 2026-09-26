import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { prepareSmsReply, attachSmsReply, reserveSmsReply, readSmsReply, recordSmsReplyDelivery, validateSmsReplyReceipt,
  SmsReplyInvalidDeliveryError, SmsReplyUnavailableError, type SmsReplyBinding, type SmsReplyCandidate,
  type SmsReplyDeliveryInput, type SmsReplyDeliveryStatus } from '@/lib/contact-center/sms-reply';

const FAMILY = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333', NOW = '2026-09-12T12:00:00.000Z';
const ACCOUNT = `AC${'a'.repeat(32)}`, PROVIDER = `SM${'b'.repeat(32)}`;
const BINDING: SmsReplyBinding = { familyId: FAMILY, channelId: FAMILY, smsSid: `SM${'a'.repeat(32)}`,
  from: '+15555550200', to: '+15555550100', body: 'Synthetic appointment note' };
const CANDIDATE: SmsReplyCandidate = { summary: 'A note', intent: 'appointment', reply: 'Frozen reply', locale: 'en-US', suppression: null };
type Row = Record<string, unknown>;
type Call = { table: string; method: string; url: URL; body: Row | null; signal: AbortSignal | null | undefined };
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: Row, url: URL): boolean {
  return [...url.searchParams].every(([key, filter]) => {
    const [column, path] = key.split('->>'), value = path ? (row[column] as Row)?.[path] : row[key];
    if (filter.startsWith('eq.')) return typeof value === 'object' && value !== null
      ? JSON.stringify(value) === JSON.stringify(JSON.parse(filter.slice(3))) : String(value) === filter.slice(3);
    return filter !== 'is.null' || value === null;
  });
}
function fixture() {
  const state = {
    tables: { ai_tool_calls: [], family_inbox_messages: [], family_contact_channels: [{ family_id: FAMILY, phone_number: BINDING.to, ai_concierge_enabled: true }] } as Record<string, Row[]>,
    calls: [] as Call[], before: undefined as ((call: Call) => void | Promise<void>) | undefined,
    after: undefined as ((call: Call, found: Row[]) => void | Promise<void>) | undefined,
    fail: '' as string, count: undefined as ((call: Call, count: number) => number | null) | undefined,
    response: undefined as ((call: Call, found: Row[]) => unknown) | undefined,
  };
  const client = createClient<Database>('https://sms-delivery-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init = {}) => {
      const url = new URL(String(input)), table = url.pathname.split('/').pop()!;
      if (!(table in state.tables)) throw new Error('Unexpected synthetic table');
      const call: Call = { table, method: init.method ?? 'GET', url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal };
      state.calls.push(call); await state.before?.(call);
      if (state.fail === `${call.method}:${table}`) return Response.json({ code: '42501', message: 'Synthetic failure' }, { status: 503 });
      let found: Row[];
      if (call.method === 'POST') {
        const value = clone(call.body!);
        if (state.tables[table].some(row => row.id === value.id || table === 'ai_tool_calls' && row.family_id === value.family_id && row.idempotency_key === value.idempotency_key
          || table === 'family_inbox_messages' && row.channel === value.channel && row.provider_ref === value.provider_ref)) {
          return Response.json({ code: '23505', message: 'Synthetic collision' }, { status: 409 });
        }
        const row = { ...(table === 'family_inbox_messages' ? { occurred_at: NOW } : {}), created_at: NOW, updated_at: NOW, ...value };
        state.tables[table].push(row); found = [row];
      } else {
        found = state.tables[table].filter(row => matches(row, url));
        if (call.method === 'PATCH') for (const row of found) Object.assign(row, clone(call.body));
        else if (call.method !== 'GET') throw new Error('Unexpected fixture method');
      }
      await state.after?.(call, found);
      const count = state.count ? state.count(call, found.length) : found.length;
      return Response.json(state.response ? state.response(call, found) : clone(found), {
        status: call.method === 'POST' ? 201 : 200,
        headers: count === null ? {} : { 'content-range': `0-${Math.max(0, found.length - 1)}/${count}` },
      });
    } },
  });
  return { client, state };
}
type Fixture = ReturnType<typeof fixture>;
const ledger = (f: Fixture) => f.state.tables.ai_tool_calls[0];
const incoming = (f: Fixture) => f.state.tables.family_inbox_messages.find(row => row.direction === 'inbound')!;
const outgoing = (f: Fixture) => f.state.tables.family_inbox_messages.find(row => row.direction === 'outbound')!;
const delivery = (f: Fixture) => (ledger(f).outputs as Row).delivery as Row | undefined;
async function ready(account: string | undefined = ACCOUNT) {
  const f = fixture();
  const prepared = await prepareSmsReply(f.client, BINDING, async () => CANDIDATE);
  f.state.tables.family_inbox_messages.push({ id: MESSAGE, family_id: FAMILY, channel: 'sms', direction: 'inbound', from_addr: BINDING.from,
    to_addr: BINDING.to, body: BINDING.body, subject: null, ai_summary: CANDIDATE.summary, ai_intent: CANDIDATE.intent,
    ai_handled: true, status: 'read', provider_ref: BINDING.smsSid, occurred_at: NOW });
  const attached = await attachSmsReply(f.client, prepared, MESSAGE);
  const result = await reserveSmsReply(f.client, attached, { ...(account ? { accountSid: account } : {}) });
  expect(result.emission).toBe(CANDIDATE.reply);
  const input: SmsReplyDeliveryInput = { receiptId: result.receipt.id, emissionToken: result.receipt.emissionToken!, providerSid: PROVIDER,
    status: 'queued', from: BINDING.to, to: BINDING.from!, ...(account ? { accountSid: account } : {}) };
  f.state.calls.length = 0;
  return { ...f, receipt: result.receipt, input };
}
const unavailable = (value: Promise<unknown>) => expect(value).rejects.toEqual(new SmsReplyUnavailableError());
const invalid = (value: Promise<unknown>) => expect(value).rejects.toEqual(new SmsReplyInvalidDeliveryError());
afterEach(() => vi.restoreAllMocks());

describe('Private SMS provider observations with the installed SDK', () => {
  it('stores the signed reservation account and keeps emission held before any callback', async () => {
    const f = await ready();
    expect(f.receipt).toMatchObject({ phase: 'emission_reserved', delivery: null, emissionAccountSid: ACCOUNT });
    expect(ledger(f).outputs).toMatchObject({ emissionAccountSid: ACCOUNT });
    expect(ledger(f).outputs).not.toHaveProperty('delivery');
    const before = clone(ledger(f));
    expect((await reserveSmsReply(f.client, f.receipt, { accountSid: `AC${'c'.repeat(32)}` })).emission).toBeNull();
    expect(ledger(f)).toEqual(before);
  });

  it('keeps old v1 rows without new fields unchanged until a verified observation', async () => {
    const f = await ready('');
    expect(ledger(f).outputs).not.toHaveProperty('delivery'); expect(ledger(f).outputs).not.toHaveProperty('emissionAccountSid');
    const before = clone(ledger(f));
    expect(await readSmsReply(f.client, BINDING)).toMatchObject({ delivery: null, emissionAccountSid: null });
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull(); expect(ledger(f)).toEqual(before);
    expect(await recordSmsReplyDelivery(f.client, f.input)).toEqual({ outcome: 'updated' });
    expect(ledger(f).outputs).not.toHaveProperty('emissionAccountSid'); expect(delivery(f)?.status).toBe('queued');
  });

  it('does not infer an old emission account from a supplied callback account', async () => {
    const f = await ready(''), before = clone(ledger(f));
    await invalid(recordSmsReplyDelivery(f.client, { ...f.input, accountSid: ACCOUNT })); expect(ledger(f)).toEqual(before);
  });

  it.each(['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'] as const)('accepts a first verified %s observation with exact linked effects', async status => {
    const f = await ready(), before = clone(f.state.tables.family_inbox_messages);
    expect(await recordSmsReplyDelivery(f.client, { ...f.input, status })).toEqual({ outcome: 'updated' });
    expect(delivery(f)).toEqual({ providerSid: PROVIDER, status, observedAt: expect.any(String) });
    expect(ledger(f)).toMatchObject({ state: 'reserved', attempt: 1, outputs: { phase: 'emission_reserved', emissionToken: f.receipt.emissionToken } });
    expect(f.state.tables.family_inbox_messages).toEqual(before);
    expect(f.state.calls.filter(call => call.method !== 'GET').map(call => `${call.method}:${call.table}`)).toEqual(['PATCH:ai_tool_calls']);
    expect(f.state.calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
    const patch = f.state.calls.findIndex(call => call.method === 'PATCH');
    expect(f.state.calls.slice(0, patch).filter(call => call.table === 'family_inbox_messages')).toHaveLength(2);
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it('advances in order and makes same/reordered status callbacks no-ops without revision churn', async () => {
    const f = await ready();
    for (const status of ['queued', 'sending', 'sent', 'delivered'] as const) {
      const beforeRevision = (ledger(f).outputs as Row).revision;
      expect(await recordSmsReplyDelivery(f.client, { ...f.input, status })).toEqual({ outcome: 'updated' });
      expect((ledger(f).outputs as Row).revision).not.toBe(beforeRevision);
      const before = clone(ledger(f));
      for (const repeat of ['queued', status] as const) expect(await recordSmsReplyDelivery(f.client, { ...f.input, status: repeat })).toEqual({ outcome: 'unchanged' });
      expect(ledger(f)).toEqual(before);
    }
    expect(f.state.calls.filter(call => call.method === 'PATCH')).toHaveLength(4);
  });

  it.each(['delivered', 'undelivered', 'failed'] as const)('preserves the first terminal %s outcome even when a contradictory terminal follows', async terminal => {
    const f = await ready(); await recordSmsReplyDelivery(f.client, { ...f.input, status: terminal });
    const before = clone(ledger(f)); f.state.calls.length = 0;
    for (const status of ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'] as const) {
      expect(await recordSmsReplyDelivery(f.client, { ...f.input, status })).toEqual({ outcome: 'unchanged' });
    }
    expect(ledger(f)).toEqual(before); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('permits absent optional observations but keeps the previously bound account and provider SID', async () => {
    const f = await ready();
    const minimal = { receiptId: f.input.receiptId, emissionToken: f.input.emissionToken, providerSid: PROVIDER, status: 'sent' as const };
    expect(await recordSmsReplyDelivery(f.client, minimal)).toEqual({ outcome: 'updated' });
    expect(await recordSmsReplyDelivery(f.client, { ...f.input, status: 'sent', providerSid: PROVIDER.toLowerCase(), accountSid: ACCOUNT.toLowerCase() })).toEqual({ outcome: 'unchanged' });
  });

  it('can record historical delivery after the current number has been reassigned, without sending anything', async () => {
    const f = await ready(); f.state.tables.family_contact_channels[0].family_id = OTHER;
    expect(await recordSmsReplyDelivery(f.client, { ...f.input, status: 'delivered' })).toEqual({ outcome: 'updated' });
    expect(f.state.calls.some(call => call.table === 'family_contact_channels')).toBe(false);
    expect(f.state.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it.each([
    ['receiptId', OTHER], ['emissionToken', OTHER], ['providerSid', BINDING.smsSid],
    ['from', '+15555550999'], ['to', '+15555550999'], ['accountSid', `AC${'c'.repeat(32)}`],
  ])('rejects the wrong callback %s before changing private state', async (field, value) => {
    const f = await ready(), before = clone(ledger(f));
    await invalid(recordSmsReplyDelivery(f.client, { ...f.input, [field]: value }));
    expect(ledger(f)).toEqual(before); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each([
    ['receiptId', 'invalid'], ['emissionToken', 'invalid'], ['providerSid', 'SM-invalid'], ['status', 'accepted'],
    ['from', ''], ['to', 'untrusted'], ['accountSid', 'AC-bad'],
  ])('rejects malformed %s without querying storage', async (field, value) => {
    const f = await ready(); await invalid(recordSmsReplyDelivery(f.client, { ...f.input, [field]: value } as SmsReplyDeliveryInput));
    expect(f.state.calls).toEqual([]);
  });

  it('does not let a different provider SID replace the first binding, including after terminal delivery', async () => {
    const f = await ready(); await recordSmsReplyDelivery(f.client, { ...f.input, status: 'delivered' });
    const before = clone(ledger(f));
    await invalid(recordSmsReplyDelivery(f.client, { ...f.input, providerSid: `SM${'c'.repeat(32)}`, status: 'failed' }));
    expect(ledger(f)).toEqual(before);
  });

  it('rejects a valid private receipt that has never reserved emission', async () => {
    const f = fixture(), receipt = await prepareSmsReply(f.client, BINDING, async () => CANDIDATE);
    await invalid(recordSmsReplyDelivery(f.client, { receiptId: receipt.id, emissionToken: OTHER, providerSid: PROVIDER, status: 'sent' }));
    expect((ledger(f).outputs as Row).phase).toBe('queued');
  });

  it.each(['inbound', 'outbound'])('does not recreate a missing %s effect', async direction => {
    const f = await ready(); f.state.tables.family_inbox_messages = f.state.tables.family_inbox_messages.filter(row => row.direction !== direction);
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
    expect(delivery(f)).toBeUndefined();
  });

  it.each(['family_id', 'from_addr', 'to_addr', 'body', 'subject', 'ai_summary', 'ai_intent', 'status', 'occurred_at'])('refuses tampered inbound %s before delivery updates', async field => {
    const f = await ready(); incoming(f)[field] = 'altered';
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(delivery(f)).toBeUndefined();
  });

  it.each(['family_id', 'from_addr', 'to_addr', 'body', 'provider_ref', 'subject', 'ai_summary', 'ai_intent', 'ai_handled', 'status', 'occurred_at'])('refuses tampered outbound %s before delivery updates', async field => {
    const f = await ready(); outgoing(f)[field] = 'altered';
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(delivery(f)).toBeUndefined();
  });

  it.each(['family_id', 'actor_kind', 'tool_name', 'requested_by', 'requested_by_member_id', 'run_id', 'resource_id', 'state', 'attempt', 'locked_at', 'finished_at'])('holds corrupted service metadata %s as unavailable', async field => {
    const f = await ready(); ledger(f)[field] = 'altered';
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(delivery(f)).toBeUndefined();
  });

  it.each([null, { providerSid: PROVIDER, status: 'accepted', observedAt: NOW },
    { providerSid: PROVIDER, status: 'sent', observedAt: 'invalid' },
    { providerSid: BINDING.smsSid, status: 'sent', observedAt: NOW },
    { providerSid: PROVIDER, status: 'sent', observedAt: NOW, extra: 'untrusted' }])('rejects a malformed stored delivery payload %j', async value => {
    const f = await ready(); (ledger(f).outputs as Row).delivery = value;
    expect(() => validateSmsReplyReceipt(ledger(f))).toThrow(SmsReplyUnavailableError);
    await unavailable(recordSmsReplyDelivery(f.client, f.input));
  });

  it.each([null, 2])('does not trust a missing or cap-hidden read count %s', async count => {
    const f = await ready(); f.state.count = () => count;
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(f.state.calls).toHaveLength(1);
  });

  it.each(['GET:ai_tool_calls', 'GET:family_inbox_messages', 'PATCH:ai_tool_calls'])('bounds a required HTTP failure at %s and never claims an observation', async failure => {
    const f = await ready(); f.state.fail = failure;
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(delivery(f)).toBeUndefined();
    expect(f.state.calls.filter(call => `${call.method}:${call.table}` === failure).length).toBeLessThanOrEqual(3);
  });

  it('reconciles a committed status whose transport response was lost without sending or duplicating it', async () => {
    const f = await ready();
    f.state.after = call => { if (call.method === 'PATCH') throw new Error('Synthetic committed response loss'); };
    expect(await recordSmsReplyDelivery(f.client, f.input)).toEqual({ outcome: 'unchanged' });
    expect(delivery(f)?.status).toBe('queued'); expect(f.state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it.each([null, [], [{ id: OTHER }]])('requires checked readback after an unusable status response %j', async response => {
    const f = await ready(); f.state.response = (call, found) => call.method === 'PATCH' ? response : clone(found);
    expect(await recordSmsReplyDelivery(f.client, f.input)).toEqual({ outcome: 'unchanged' }); expect(delivery(f)?.status).toBe('queued');
    expect(f.state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('fails when a committed response and the required reconciliation read are both unavailable', async () => {
    const f = await ready(); f.state.after = call => { if (call.method === 'PATCH') { f.state.fail = 'GET:ai_tool_calls'; throw new Error('Synthetic response lost'); } };
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(delivery(f)?.status).toBe('queued');
  });

  it('converges overlapping same-provider observations to the furthest state with exact CAS', async () => {
    const f = await ready(); let pending = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.state.before = call => { if (call.method === 'PATCH' && ++pending <= 2) { if (pending === 2) release(); return gate; } };
    const results = await Promise.all([
      recordSmsReplyDelivery(f.client, { ...f.input, status: 'queued' }),
      recordSmsReplyDelivery(f.client, { ...f.input, status: 'delivered' }),
    ]);
    expect(results.every(result => ['updated', 'unchanged'].includes(result.outcome))).toBe(true);
    expect(delivery(f)?.status).toBe('delivered'); expect(f.state.calls.filter(call => call.method === 'PATCH').length).toBeLessThanOrEqual(3);
  });

  it('lets only the first competing provider SID bind the reservation', async () => {
    const f = await ready(); let pending = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.state.before = call => { if (call.method === 'PATCH' && ++pending <= 2) { if (pending === 2) release(); return gate; } };
    const results = await Promise.allSettled([
      recordSmsReplyDelivery(f.client, f.input),
      recordSmsReplyDelivery(f.client, { ...f.input, providerSid: `SM${'c'.repeat(32)}` }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toEqual(new SmsReplyInvalidDeliveryError());
  });

  it('stops after three status CAS losses without changing delivery', async () => {
    const f = await ready(); let counter = 0;
    f.state.before = call => { if (call.method === 'PATCH') (ledger(f).outputs as Row).revision = `44444444-4444-4444-8444-${String(++counter).padStart(12, '0')}`; };
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(counter).toBe(3); expect(delivery(f)).toBeUndefined();
  });

  it('preserves archived projections and does not change emission identity after a verified failure', async () => {
    const f = await ready(); outgoing(f).status = 'archived'; const before = clone(f.state.tables.family_inbox_messages);
    await recordSmsReplyDelivery(f.client, { ...f.input, status: 'failed' });
    expect(f.state.tables.family_inbox_messages).toEqual(before);
    expect(await readSmsReply(f.client, BINDING)).toMatchObject({ emissionToken: f.receipt.emissionToken,
      emissionReservedAt: f.receipt.emissionReservedAt, delivery: { status: 'failed' } });
    expect((await reserveSmsReply(f.client, f.receipt)).emission).toBeNull();
  });

  it('cannot continue from an initial read that ignored caller cancellation', async () => {
    const f = await ready(), controller = new AbortController(); let release!: () => void;
    f.state.before = () => new Promise<void>(resolve => { release = resolve; });
    const work = recordSmsReplyDelivery(f.client, f.input, { signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort(); await unavailable(work);
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.state.calls).toHaveLength(1); expect(delivery(f)).toBeUndefined();
  });

  it('holds a late committed status after abort and reconciles only on the next verified callback', async () => {
    const f = await ready(), controller = new AbortController(); let release!: () => void;
    f.state.before = call => call.method === 'PATCH' ? new Promise<void>(resolve => { release = resolve; }) : undefined;
    const work = recordSmsReplyDelivery(f.client, f.input, { signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort(); await unavailable(work);
    const count = f.state.calls.length; release(); await new Promise(resolve => setTimeout(resolve, 10)); f.state.before = undefined;
    expect(f.state.calls).toHaveLength(count); expect(delivery(f)?.status).toBe('queued');
    expect(await recordSmsReplyDelivery(f.client, f.input)).toEqual({ outcome: 'unchanged' });
  });

  it('expires a never-resolving transport at its own request deadline', async () => {
    const f = await ready();
    // Keep the production deadline behavior, shorten only its native timer.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 5000 ? 20 : ms));
    f.state.before = () => new Promise<void>(() => {});
    await unavailable(recordSmsReplyDelivery(f.client, f.input)); expect(f.state.calls).toHaveLength(1);
  });
});
