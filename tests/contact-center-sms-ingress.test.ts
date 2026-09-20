import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { captureSmsIngress, readSmsIngress, readLegacySmsReplyForIngress, readLegacyUrgentForIngress, smsIngressReceiptId,
  SmsIngressUnavailableError, type SmsIngressCapture, type SmsIngressEnvelope } from '@/lib/contact-center/sms-ingress';
import { smsReplyReceiptId, smsReplyOutboundId, validateSmsReplyReceipt } from '@/lib/contact-center/sms-reply';
import { validateUrgentDeliveryReceipt } from '@/lib/contact-center/urgent-delivery';

const FAMILY = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-12T12:00:00.000Z', ACCOUNT = `AC${'a'.repeat(32)}`;
const ENVELOPE: SmsIngressEnvelope = { smsSid: `SM${'b'.repeat(32)}`, accountSid: ACCOUNT,
  from: '+15555550200', to: '+15555550100', body: 'Synthetic appointment note' };
const INPUT: SmsIngressCapture = { ...ENVELOPE, familyId: FAMILY, channelId: FAMILY };
type Row = Record<string, unknown>;
type Call = { method: string; url: URL; body: Row | null; signal: AbortSignal | null | undefined; headers: Headers };
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function matches(row: Row, url: URL) {
  return [...url.searchParams].every(([key, filter]) => {
    let value: unknown = row;
    for (const path of key.split(/->>?/)) value = value && typeof value === 'object' ? (value as Row)[path] : undefined;
    if (filter.startsWith('eq.')) return String(value) === filter.slice(3);
    if (filter.startsWith('ilike.')) return typeof value === 'string' && value.toLowerCase() === filter.slice(6).toLowerCase();
    return true;
  });
}
/** Actual installed PostgREST transport; only this explicit synthetic host is serviced. */
function fixture() {
  const state = { rows: [] as Row[], calls: [] as Call[],
    before: undefined as ((call: Call) => void | Response | Promise<void | Response>) | undefined,
    after: undefined as ((call: Call, rows: Row[]) => void | Response | Promise<void | Response>) | undefined,
    response: undefined as ((call: Call, rows: Row[]) => unknown) | undefined,
    count: undefined as ((call: Call, count: number) => number | null) | undefined };
  const client = createClient<Database>('https://sms-ingress-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw));
      if (url.origin !== 'https://sms-ingress-fixture.invalid' || url.pathname !== '/rest/v1/ai_tool_calls') throw new Error('Unexpected fixture transport');
      const call: Call = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        signal: init.signal, headers: new Headers(init.headers) };
      state.calls.push(call);
      const early = await state.before?.(call); if (early) return early;
      let found: Row[];
      if (call.method === 'POST') {
        const body = clone(call.body!);
        if (state.rows.some(row => row.id === body.id || row.family_id === body.family_id && row.idempotency_key === body.idempotency_key)) {
          return Response.json({ code: '23505', message: 'Synthetic primary-key conflict' }, { status: 409 });
        }
        const saved = { created_at: NOW, updated_at: NOW, ...body };
        state.rows.push(saved); found = [saved];
      } else if (call.method === 'GET') found = state.rows.filter(row => matches(row, url));
      else throw new Error('Ingress may not update, delete or call other services');
      const late = await state.after?.(call, found); if (late) return late;
      const count = state.count ? state.count(call, found.length) : found.length;
      return Response.json(state.response ? state.response(call, clone(found)) : clone(found), {
        status: call.method === 'POST' ? 201 : 200,
        headers: count === null ? {} : { 'content-range': `0-${Math.max(0, found.length - 1)}/${count}` },
      });
    } },
  });
  return { client, state };
}
type Fixture = ReturnType<typeof fixture>;
const unavailable = (promise: Promise<unknown>) => expect(promise).rejects.toEqual(new SmsIngressUnavailableError());
async function captured(input = INPUT) {
  const f = fixture(), receipt = await captureSmsIngress(f.client, input);
  f.state.calls.length = 0; return { ...f, receipt };
}
const inputs = (row: Row) => row.inputs as Row;
const binding = (row: Row) => inputs(row).binding as Row;
const outputs = (row: Row) => row.outputs as Row;
function fingerprint(row: Row) {
  const value = inputs(row);
  value.fingerprint = hash(JSON.stringify({ normalizationVersion: 1, binding: value.binding, accountSid: value.accountSid, bodyDigest: value.bodyDigest }));
}
function legacy(f: Fixture, familyId = FAMILY, smsSid = ENVELOPE.smsSid) {
  const bound = { familyId, channelId: familyId, smsSid, from: ENVELOPE.from, to: ENVELOPE.to, body: ENVELOPE.body };
  const candidate = { summary: 'A note', intent: 'appointment', reply: 'Synthetic reply', locale: 'en-US', suppression: null };
  const row: Row = { id: smsReplyReceiptId(familyId, smsSid), family_id: familyId, tool_name: 'contact_center.sms_reply', actor_kind: 'system',
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
    inputs: { version: 1, policyVersion: 1, binding: bound, candidate, fingerprint: hash(JSON.stringify({ binding: bound, candidate })) },
    outputs: { version: 1, revision: OTHER, phase: 'queued', inboundId: null, outboundId: null, emissionToken: null, emissionReservedAt: null, reason: null },
    state: 'reserved', attempt: 0, locked_at: null, duration_ms: null, error: null,
    idempotency_key: `contact_center.sms_reply:v1:${hash(JSON.stringify([familyId, 'sms', smsSid.toLowerCase()]))}`,
    resource_table: 'family_inbox_messages', resource_id: null, finished_at: null, created_at: NOW, updated_at: NOW };
  validateSmsReplyReceipt(row); f.state.rows.push(row); return row;
}
function oldUrgent(f: Fixture, familyId = FAMILY, smsSid = ENVELOPE.smsSid) {
  const key = `contact_center.urgent_delivery:${hash(JSON.stringify([familyId, 'sms', smsSid]))}`, hex = hash(key);
  const row: Row = { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    family_id: familyId, tool_name: 'contact_center.urgent_delivery', actor_kind: 'system', idempotency_key: key,
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
    inputs: { version: 1, familyId, channel: 'sms', providerRef: smsSid, from: ENVELOPE.from, to: ENVELOPE.to,
      subject: null, body: ENVELOPE.body, summary: 'Stored urgent summary', intent: 'urgent' },
    outputs: { version: 1, revision: OTHER, phase: 'queued', notificationDone: false, drain: true, retryAt: null,
      destination: null, providerSid: null, providerStatus: null },
    state: 'reserved', attempt: 0, locked_at: null, duration_ms: null, error: null, resource_table: 'family_inbox_messages',
    resource_id: null, finished_at: null, created_at: NOW, updated_at: NOW };
  f.state.rows.push(row); return row;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('immutable SMS ingress using installed PostgREST', () => {
  it('retains exact signed input before any reply work and verifies a fresh readback', async () => {
    const f = fixture(); expect(await readSmsIngress(f.client, ENVELOPE)).toBeNull();
    const receipt = await captureSmsIngress(f.client, INPUT);
    expect(receipt).toEqual({ id: smsIngressReceiptId(ENVELOPE.smsSid), binding: { familyId: FAMILY, channelId: FAMILY,
      smsSid: ENVELOPE.smsSid, from: ENVELOPE.from, to: ENVELOPE.to, body: ENVELOPE.body }, accountSid: ACCOUNT,
      bodyDigest: hash(JSON.stringify(ENVELOPE.body)), capturedAt: expect.any(String) });
    expect(f.state.calls.map(call => call.method)).toEqual(['GET', 'GET', 'POST', 'GET']);
    expect(f.state.rows[0]).toMatchObject({ tool_name: 'contact_center.sms_ingress', actor_kind: 'system', state: 'succeeded', attempt: 1,
      resource_table: null, resource_id: null, requested_by: null, locked_at: null, error: null,
      outputs: { version: 1, phase: 'captured', capturedAt: receipt.capturedAt } });
    expect(f.state.calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('created_at');
    expect(f.state.calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('updated_at');
    expect(f.state.calls.filter(call => call.method === 'GET').every(call => call.url.searchParams.get('id') === `eq.${receipt.id}`
      && call.url.searchParams.get('limit') === '2' && !call.url.searchParams.has('tool_name')
      && call.headers.get('prefer')?.includes('count=exact'))).toBe(true);
    const before = clone(f.state.rows); f.state.calls.length = 0;
    expect(await captureSmsIngress(f.client, INPUT)).toEqual(receipt);
    expect(await readSmsIngress(f.client, ENVELOPE)).toEqual(receipt);
    expect(f.state.rows).toEqual(before); expect(f.state.calls.map(call => call.method)).toEqual(['GET', 'GET']);
  });

  it('canonicalizes provider and UUID case while keeping one global SID identity', async () => {
    const family = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', f = fixture();
    const receipt = await captureSmsIngress(f.client, { ...INPUT, familyId: family.toUpperCase(), channelId: family,
      smsSid: ENVELOPE.smsSid.toUpperCase(), accountSid: ACCOUNT.toUpperCase() });
    expect(receipt.binding.familyId).toBe(family); expect(receipt.binding.smsSid).toBe(ENVELOPE.smsSid);
    expect(receipt.accountSid).toBe(ACCOUNT);
    expect(await readSmsIngress(f.client, { ...ENVELOPE, smsSid: ENVELOPE.smsSid.toLowerCase(), accountSid: ACCOUNT.toLowerCase() })).toEqual(receipt);
    expect(smsIngressReceiptId(ENVELOPE.smsSid.toUpperCase())).toBe(smsIngressReceiptId(ENVELOPE.smsSid));
  });

  it.each([null, 'ALPHANUMERIC', '+15555550200'])('retains supported exact sender observations: %s', async from => {
    const f = await captured({ ...INPUT, from }); expect(f.receipt.binding.from).toBe(from);
  });

  it('stores valid scalar-safe text but hashes the complete original decoded body', async () => {
    const body = 'a\u0000\ud800\u0001' + 'x'.repeat(4090) + '\u{1f600}tail';
    const f = await captured({ ...INPUT, body });
    expect(f.receipt.binding.body).toBe('a\ufffd\ufffd\u0001' + 'x'.repeat(4090) + '\u{1f600}');
    expect(f.receipt.bodyDigest).toBe(hash(JSON.stringify(body)));
    const boundary = await captured({ ...INPUT, body: 'x'.repeat(4095) + '\u{1f600}' });
    expect(boundary.receipt.binding.body).toBe('x'.repeat(4095));
  });

  it.each([
    ['replacement collision', '\u0000', '\ufffd'], ['surrogate collision', '\ud800', '\udc00'],
    ['truncated tail collision', 'x'.repeat(4096) + 'A', 'x'.repeat(4096) + 'B'],
  ])('rejects the same normalized text with a different original body: %s', async (_name, first, second) => {
    const f = await captured({ ...INPUT, body: first }), before = clone(f.state.rows);
    await unavailable(readSmsIngress(f.client, { ...ENVELOPE, body: second }));
    await unavailable(captureSmsIngress(f.client, { ...INPUT, body: second }));
    expect(f.state.rows).toEqual(before); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });

  const changedEnvelopes: Partial<SmsIngressEnvelope>[] = [{ accountSid: null }, { accountSid: `AC${'c'.repeat(32)}` },
    { from: null }, { from: '+15555550300' }, { to: '+15555550400' }, { body: 'Different signed body' }];
  it.each(changedEnvelopes)('rejects changed identity without creating a second partition: %j', async change => {
    const f = await captured(), before = clone(f.state.rows);
    await unavailable(captureSmsIngress(f.client, { ...INPUT, ...change }));
    expect(f.state.rows).toEqual(before); expect(f.state.calls).toHaveLength(1);
  });
  it('keeps missing account observation immutable when a later callback supplies one', async () => {
    const f = await captured({ ...INPUT, accountSid: null });
    await unavailable(readSmsIngress(f.client, ENVELOPE)); expect(f.state.rows).toHaveLength(1);
  });
  it('reads retained original family for the route but refuses capture for another family', async () => {
    const f = await captured(); expect((await readSmsIngress(f.client, ENVELOPE))?.binding.familyId).toBe(FAMILY);
    await unavailable(captureSmsIngress(f.client, { ...INPUT, familyId: OTHER, channelId: OTHER }));
    expect(f.state.rows).toHaveLength(1); expect(f.state.rows[0].family_id).toBe(FAMILY);
  });

  const invalid: Row[] = [{ smsSid: 'SMbad' }, { smsSid: `SM${'b'.repeat(32)}%` }, { accountSid: undefined },
    { accountSid: 'ACbad' }, { from: '' }, { from: 'line\nfeed' }, { from: '\ud800' }, { from: 'x'.repeat(65) },
    { to: '+12' }, { body: null }, { body: 'x'.repeat(65537) }, { familyId: 'foreign' }, { channelId: OTHER }, { extra: true }];
  it.each(invalid)('rejects malformed caller input before querying: %j', async change => {
    const f = fixture(); await unavailable(captureSmsIngress(f.client, { ...INPUT, ...change })); expect(f.state.calls).toEqual([]);
  });

  const altered: Array<[string, (row: Row) => void]> = [
    ...['requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id', 'conversation_id', 'message_id',
      'locked_at', 'duration_ms', 'error', 'resource_table', 'resource_id'].map(key => [key, (row: Row) => { row[key] = OTHER; }] as [string, (row: Row) => void]),
    ['id', row => { row.id = OTHER; }], ['key', row => { row.idempotency_key = 'foreign'; }],
    ['family', row => { row.family_id = OTHER; }], ['tool namespace', row => { row.tool_name = 'guardian.sms_intake'; }],
    ['actor', row => { row.actor_kind = 'parent'; }], ['state', row => { row.state = 'reserved'; }], ['attempt', row => { row.attempt = 0; }],
    ['missing top-level metadata', row => { delete row.request_id; }], ['extra top-level metadata', row => { row.unexpected = true; }],
    ['inputs version', row => { inputs(row).version = 2; }], ['normalization version', row => { inputs(row).normalizationVersion = 2; }],
    ['inputs unknown property', row => { inputs(row).signature = 'not permitted'; }], ['outputs unknown property', row => { outputs(row).token = OTHER; }],
    ['outputs phase', row => { outputs(row).phase = 'emitted'; }], ['outputs version', row => { outputs(row).version = 2; }],
    ['fingerprint', row => { inputs(row).fingerprint = 'a'.repeat(64); }], ['original digest', row => { inputs(row).bodyDigest = 'a'.repeat(64); fingerprint(row); }],
    ['body', row => { binding(row).body = 'different'; fingerprint(row); }], ['phone', row => { binding(row).to = '+15555550400'; fingerprint(row); }],
    ['channel', row => { binding(row).channelId = OTHER; fingerprint(row); }],
    ['stored SID canonical case', row => { binding(row).smsSid = ENVELOPE.smsSid.toUpperCase(); fingerprint(row); }],
    ['stored account canonical case', row => { inputs(row).accountSid = ACCOUNT.toUpperCase(); fingerprint(row); }],
    ['created timestamp', row => { row.created_at = 'bad'; }], ['updated timestamp', row => { row.updated_at = '2000-01-01T00:00:00.000Z'; }],
    ['finished timestamp', row => { row.finished_at = null; }], ['captured timestamp', row => { outputs(row).capturedAt = '2000-01-01T00:00:00.000Z'; }],
  ];
  it.each(altered)('rejects altered storage evidence: %s', async (_name, change) => {
    const f = await captured();
    // Corrupt transport receipts too: an ID filter is not itself proof that a returned row matches.
    f.state.response = (_call, rows) => { const result = clone(rows); change(result[0]); return result; };
    await unavailable(readSmsIngress(f.client, ENVELOPE)); expect(f.state.calls).toHaveLength(1);
  });
  it('accepts PostgreSQL timestamp offset normalization without rewriting the row', async () => {
    const f = await captured();
    for (const field of ['created_at', 'updated_at', 'finished_at']) f.state.rows[0][field] = String(f.state.rows[0][field]).replace('Z', '+00:00');
    expect(await readSmsIngress(f.client, ENVELOPE)).toEqual(f.receipt);
  });
  it('accepts independently managed database creation time while verifying immutable finish time', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T12:00:05.000Z'));
    const f = await captured();
    expect(f.state.rows[0]).toMatchObject({ created_at: NOW, updated_at: NOW, finished_at: '2026-09-12T12:00:05.000Z' });
    expect(await readSmsIngress(f.client, ENVELOPE)).toEqual(f.receipt);
  });

  it.each([null, 0, 2])('refuses incomplete or inconsistent count evidence (%s)', async count => {
    const f = await captured(); f.state.count = () => count; await unavailable(readSmsIngress(f.client, ENVELOPE));
  });
  it.each([null, {}, 'not rows', [null], [{ id: OTHER }]])('refuses malformed read data: %j', async response => {
    const f = fixture(); f.state.response = () => response; await unavailable(readSmsIngress(f.client, ENVELOPE));
  });
  it('refuses duplicate rows and a total larger than the limited page', async () => {
    const f = await captured(); f.state.rows.push(clone(f.state.rows[0]));
    await unavailable(readSmsIngress(f.client, ENVELOPE));
    f.state.rows.pop(); f.state.count = () => 5; await unavailable(readSmsIngress(f.client, ENVELOPE));
  });
  it.each([429, 500])('never retries a failed read automatically (HTTP %i)', async status => {
    const f = fixture(); f.state.before = () => Response.json({ message: 'Synthetic outage' }, { status });
    await unavailable(captureSmsIngress(f.client, INPUT)); expect(f.state.calls).toHaveLength(1);
  });
  it('treats a thrown read as unavailable without inserting', async () => {
    const f = fixture(); f.state.before = () => { throw new Error('Synthetic connection loss'); };
    await unavailable(captureSmsIngress(f.client, INPUT)); expect(f.state.calls).toHaveLength(1);
  });

  it.each(['throw', '500', 'malformed'])('recovers only from fresh durable evidence after an uncertain insert: %s', async mode => {
    const f = fixture();
    f.state.after = call => { if (call.method === 'POST') {
      if (mode === 'throw') throw new Error('Synthetic lost response after commit');
      return Response.json(mode === '500' ? { message: 'Synthetic lost acknowledgement' } : { wrong: true }, { status: mode === '500' ? 500 : 201 });
    } };
    const receipt = await captureSmsIngress(f.client, INPUT);
    expect(receipt.id).toBe(smsIngressReceiptId(INPUT.smsSid));
    expect(f.state.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']); expect(f.state.rows).toHaveLength(1);
  });
  it.each([201, 429, 500])('does not trust a write response with no durable readback (HTTP %i)', async status => {
    const f = fixture(); f.state.before = call => call.method === 'POST' ? Response.json([], { status }) : undefined;
    await unavailable(captureSmsIngress(f.client, INPUT));
    expect(f.state.rows).toEqual([]); expect(f.state.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
  });
  it('retains a committed ingress on readback outage and recovers it without another insert', async () => {
    const f = fixture(); let written = false;
    f.state.after = call => { if (call.method === 'POST') written = true; };
    f.state.before = call => written && call.method === 'GET' ? Response.json({ message: 'Readback unavailable' }, { status: 503 }) : undefined;
    await unavailable(captureSmsIngress(f.client, INPUT)); expect(f.state.rows).toHaveLength(1);
    f.state.before = undefined; f.state.calls.length = 0;
    expect((await captureSmsIngress(f.client, INPUT)).binding.body).toBe(INPUT.body); expect(f.state.calls.map(call => call.method)).toEqual(['GET']);
  });
  it('does not bless malformed committed state merely because the insert succeeded', async () => {
    const f = fixture(); f.state.after = (call, rows) => { if (call.method === 'POST') rows[0].requested_by = OTHER; };
    await unavailable(captureSmsIngress(f.client, INPUT)); expect(f.state.rows).toHaveLength(1);
  });

  it('same-input concurrent callers reconcile the single immutable insert winner', async () => {
    const f = fixture(), ready = deferred(), proceed = deferred(); let initialReads = 0;
    f.state.after = async call => { if (call.method === 'GET' && ++initialReads <= 2) { if (initialReads === 2) ready.resolve(); await proceed.promise; } };
    const first = captureSmsIngress(f.client, INPUT), second = captureSmsIngress(f.client, clone(INPUT));
    await ready.promise; proceed.resolve(); const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b); expect(f.state.rows).toHaveLength(1); expect(f.state.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });
  it.each(['body', 'family', 'account'])('concurrent changed %s cannot replace or partition the winner', async change => {
    const f = fixture(), ready = deferred(), proceed = deferred(); let initialReads = 0;
    f.state.after = async call => { if (call.method === 'GET' && ++initialReads <= 2) { if (initialReads === 2) ready.resolve(); await proceed.promise; } };
    const other = change === 'body' ? { ...INPUT, body: 'Different signed body' } : change === 'family'
      ? { ...INPUT, familyId: OTHER, channelId: OTHER } : { ...INPUT, accountSid: null };
    const result = Promise.allSettled([captureSmsIngress(f.client, INPUT), captureSmsIngress(f.client, other)]);
    await ready.promise; proceed.resolve(); const settled = await result;
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1); expect(f.state.rows).toHaveLength(1);
  });
  it('captures caller values before an awaited read so later object mutation cannot change authority', async () => {
    const f = fixture(), entered = deferred(), proceed = deferred(), input = clone(INPUT);
    f.state.before = async call => { if (call.method === 'GET' && f.state.calls.length === 1) { entered.resolve(); await proceed.promise; } };
    const pending = captureSmsIngress(f.client, input); await entered.promise;
    input.body = 'Changed after dispatch'; input.familyId = OTHER; input.channelId = OTHER; input.accountSid = null;
    proceed.resolve(); const receipt = await pending;
    expect(receipt.binding.body).toBe(INPUT.body); expect(receipt.binding.familyId).toBe(FAMILY); expect(receipt.accountSid).toBe(ACCOUNT);
  });

  it.each(['read', 'insert', 'legacy', 'urgent'])('a deadline settles even when %s fetch ignores abort; late results cannot continue', async stage => {
    vi.useFakeTimers(); const f = fixture(), entered = deferred(), proceed = deferred();
    f.state.before = async call => { if (call.method === (stage === 'insert' ? 'POST' : 'GET')) { entered.resolve(); await proceed.promise; } };
    const pending = stage === 'legacy' ? readLegacySmsReplyForIngress(f.client, ENVELOPE) : stage === 'urgent'
      ? readLegacyUrgentForIngress(f.client, ENVELOPE) : captureSmsIngress(f.client, INPUT);
    const rejected = unavailable(pending); await entered.promise;
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    const count = f.state.calls.length; expect(f.state.calls.at(-1)?.signal?.aborted).toBe(true);
    proceed.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.state.calls).toHaveLength(count); expect(f.state.rows).toHaveLength(stage === 'insert' ? 1 : 0);
    // A late committed insert is retained for a later signed retry; it cannot run AI or another query here.
  });
  it.each(['GET', 'POST'])('parent cancellation fences late %s results without further requests', async method => {
    const f = fixture(), entered = deferred(), proceed = deferred(), controller = new AbortController();
    f.state.before = async call => { if (call.method === method) { entered.resolve(); await proceed.promise; } };
    const rejected = unavailable(captureSmsIngress(f.client, INPUT, { signal: controller.signal }));
    await entered.promise; controller.abort(); await rejected; const count = f.state.calls.length;
    proceed.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.state.calls).toHaveLength(count);
  });
  it('pre-aborted callers do not query or insert', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await unavailable(captureSmsIngress(f.client, INPUT, { signal: controller.signal }));
    await unavailable(readSmsIngress(f.client, ENVELOPE, { signal: controller.signal })); expect(f.state.calls).toEqual([]);
  });
});

describe('global legacy reply barrier without retrospective ingress', () => {
  it('reads a valid prior reply by case-insensitive global SID without creating a digest or ingress', async () => {
    const f = fixture(), row = legacy(f, FAMILY, ENVELOPE.smsSid.toUpperCase()), before = clone(f.state.rows);
    expect(await readLegacySmsReplyForIngress(f.client, ENVELOPE)).toEqual(validateSmsReplyReceipt(row));
    expect(f.state.rows).toEqual(before); expect(f.state.calls).toHaveLength(1);
    const query = f.state.calls[0].url.searchParams;
    expect(query.get('tool_name')).toBe('eq.contact_center.sms_reply'); expect(query.get('inputs->binding->>smsSid')).toBe(`ilike.${ENVELOPE.smsSid}`);
    expect(query.has('family_id')).toBe(false); expect(query.has('id')).toBe(false); expect(query.get('limit')).toBe('2');
  });
  it('returns the prior family to the route rather than silently hiding a foreign-family reply', async () => {
    const f = fixture(); legacy(f, OTHER);
    expect((await readLegacySmsReplyForIngress(f.client, ENVELOPE))?.binding.familyId).toBe(OTHER);
    expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('verified absence leaves unrelated tool/SID rows untouched', async () => {
    const f = fixture(); legacy(f, FAMILY, `SM${'d'.repeat(32)}`);
    f.state.rows.push({ id: OTHER, tool_name: 'guardian.sms_intake', inputs: { binding: { smsSid: ENVELOPE.smsSid } } });
    const before = clone(f.state.rows); expect(await readLegacySmsReplyForIngress(f.client, ENVELOPE)).toBeNull(); expect(f.state.rows).toEqual(before);
  });
  it.each([{ body: 'changed' }, { from: '+15555550300' }, { to: '+15555550400' }])('refuses a legacy envelope mismatch %j', async change => {
    const f = fixture(); legacy(f); await unavailable(readLegacySmsReplyForIngress(f.client, { ...ENVELOPE, ...change }));
  });
  it('does not infer a missing historical account or original tail digest', async () => {
    const f = fixture(); legacy(f);
    expect((await readLegacySmsReplyForIngress(f.client, { ...ENVELOPE, accountSid: null }))?.emissionAccountSid).toBeNull();
    expect((await readLegacySmsReplyForIngress(f.client, ENVELOPE))?.emissionAccountSid).toBeNull();
    expect(f.state.rows).toHaveLength(1); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('requires a known prior account snapshot to match when present', async () => {
    const f = fixture(), row = legacy(f), out = outputs(row);
    Object.assign(out, { phase: 'emission_reserved', inboundId: FAMILY, outboundId: smsReplyOutboundId(String(row.id)),
      emissionToken: OTHER, emissionReservedAt: NOW, emissionAccountSid: ACCOUNT });
    Object.assign(row, { attempt: 1, resource_id: FAMILY, locked_at: NOW }); validateSmsReplyReceipt(row);
    expect((await readLegacySmsReplyForIngress(f.client, ENVELOPE))?.emissionAccountSid).toBe(ACCOUNT);
    out.emissionAccountSid = ACCOUNT.toUpperCase();
    expect((await readLegacySmsReplyForIngress(f.client, ENVELOPE))?.emissionAccountSid).toBe(ACCOUNT.toUpperCase());
    await unavailable(readLegacySmsReplyForIngress(f.client, { ...ENVELOPE, accountSid: null }));
    await unavailable(readLegacySmsReplyForIngress(f.client, { ...ENVELOPE, accountSid: `AC${'c'.repeat(32)}` }));
  });
  it('rejects globally ambiguous old replies even when both are individually valid', async () => {
    const f = fixture(); legacy(f); legacy(f, OTHER); await unavailable(readLegacySmsReplyForIngress(f.client, ENVELOPE));
  });
  it.each([null, 0, 2])('does not turn incomplete legacy count %s into absence', async count => {
    const f = fixture(); legacy(f); f.state.count = () => count; await unavailable(readLegacySmsReplyForIngress(f.client, ENVELOPE));
  });
  it.each(['actor_kind', 'requested_by', 'tool_name', 'resource_id'])('validates all legacy authority fields including %s', async field => {
    const f = fixture(); legacy(f);
    f.state.response = (_call, rows) => { rows[0][field] = OTHER; return rows; };
    await unavailable(readLegacySmsReplyForIngress(f.client, ENVELOPE));
  });
  it('legacy outage is unavailable with no automatic retry or write', async () => {
    const f = fixture(); f.state.before = () => Response.json({ message: 'Synthetic outage' }, { status: 500 });
    await unavailable(readLegacySmsReplyForIngress(f.client, ENVELOPE)); expect(f.state.calls).toHaveLength(1);
  });
});

describe('older urgent-only history retains context without new ingress or reply authority', () => {
  it('finds case-preserving old identities globally and returns original intake for recovery', async () => {
    const f = fixture(), row = oldUrgent(f, FAMILY, ENVELOPE.smsSid.toUpperCase()), before = clone(f.state.rows);
    const receipt = await readLegacyUrgentForIngress(f.client, ENVELOPE);
    expect(receipt).toEqual(row); expect(receipt?.inputs.summary).toBe('Stored urgent summary');
    expect(f.state.rows).toEqual(before); expect(f.state.calls).toHaveLength(1);
    const query = f.state.calls[0].url.searchParams;
    expect(query.get('tool_name')).toBe('eq.contact_center.urgent_delivery'); expect(query.get('inputs->>channel')).toBe('eq.sms');
    expect(query.get('inputs->>providerRef')).toBe(`ilike.${ENVELOPE.smsSid}`); expect(query.has('family_id')).toBe(false);
    expect(query.has('id')).toBe(false); expect(query.get('limit')).toBe('2');
  });
  it('returns old foreign ownership for caller rejection instead of reporting absence', async () => {
    const f = fixture(); oldUrgent(f, OTHER);
    expect((await readLegacyUrgentForIngress(f.client, ENVELOPE))?.family_id).toBe(OTHER);
    expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it.each(['queued', 'dispatching', 'accepted', 'unknown', 'rejected', 'legacy_unknown', 'in_app_only'])
    ('leaves existing forwarding phase %s unchanged; this read grants no dispatch', async phase => {
      const f = fixture(), row = oldUrgent(f); outputs(row).phase = phase; const before = clone(row);
      expect((await readLegacyUrgentForIngress(f.client, ENVELOPE))?.outputs.phase).toBe(phase);
      expect(row).toEqual(before); expect(f.state.calls.every(call => call.method === 'GET')).toBe(true);
    });
  it('does not confuse an unrelated tool or provider identity with legacy SMS history', async () => {
    const f = fixture(); oldUrgent(f, FAMILY, `SM${'d'.repeat(32)}`); legacy(f);
    expect(await readLegacyUrgentForIngress(f.client, ENVELOPE)).toBeNull(); expect(f.state.rows).toHaveLength(2);
  });
  it.each([{ body: 'changed' }, { from: '+15555550300' }, { to: '+15555550400' }])('rejects changed old urgent envelope %j', async change => {
    const f = fixture(); oldUrgent(f); await unavailable(readLegacyUrgentForIngress(f.client, { ...ENVELOPE, ...change }));
  });
  it.each(['id', 'family_id', 'requested_by', 'actor_kind', 'resource_table', 'attempt'])('applies the actual urgent validator to %s', async field => {
    const f = fixture(); oldUrgent(f); f.state.response = (_call, rows) => { rows[0][field] = OTHER; return rows; };
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE));
  });
  it('rejects non-SMS returned input even when the transport ignores its query filter', async () => {
    const f = fixture(); oldUrgent(f);
    f.state.response = (_call, rows) => { inputs(rows[0]).channel = 'email'; return rows; };
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE));
  });
  it('rejects a non-null SMS subject and malformed versioned context', async () => {
    const f = fixture(), row = oldUrgent(f); inputs(row).subject = 'unexpected';
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE)); inputs(row).subject = null; outputs(row).version = 2;
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE));
  });
  it.each([null, 0, 2])('refuses incomplete global urgent read count %s', async count => {
    const f = fixture(); oldUrgent(f); f.state.count = () => count; await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE));
  });
  it('refuses ambiguous prior families without altering either record', async () => {
    const f = fixture(); oldUrgent(f); oldUrgent(f, OTHER); const before = clone(f.state.rows);
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE)); expect(f.state.rows).toEqual(before);
  });
  it('refuses unknown or missing returned metadata before exposing recovery context', async () => {
    const f = fixture(), row = oldUrgent(f); row.extra = true;
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE)); delete row.extra; delete row.run_id;
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE));
  });
  it('keeps the exported validator as the existing urgent identity boundary', async () => {
    const f = fixture(); oldUrgent(f);
    const receipt = await readLegacyUrgentForIngress(f.client, ENVELOPE);
    expect(receipt && validateUrgentDeliveryReceipt(receipt, FAMILY)).toEqual(receipt);
  });
  it('returns unavailable on urgent storage failure with no automatic retry', async () => {
    const f = fixture(); f.state.before = () => Response.json({ message: 'Synthetic outage' }, { status: 500 });
    await unavailable(readLegacyUrgentForIngress(f.client, ENVELOPE)); expect(f.state.calls).toHaveLength(1);
  });
});
