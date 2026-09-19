import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  captureGuardianSmsReceipt, saveGuardianSmsDecision, readGuardianSmsReceiptById, readGuardianSmsReceipt,
  markGuardianSmsCompleted, guardianSmsNotificationId, guardianSmsReceiptId, GuardianSmsReceiptUnavailableError,
  type GuardianSmsReceipt, type GuardianSmsDecision, type GuardianSmsReceiptInput,
} from '@/lib/guardian/sms-receipt';

const FAMILY = '11111111-1111-4111-8111-111111111111', MEMBER = '22222222-2222-4222-8222-222222222222';
const COMM = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-09-12T19:00:00.000Z';
const INPUT: GuardianSmsReceiptInput = { smsSid: `SM${'a'.repeat(32)}`, familyId: FAMILY, memberId: MEMBER,
  from: '+15555550200', to: '+15555550100', body: 'Synthetic dentist appointment tomorrow' };
const DECISION: GuardianSmsDecision = { status: 'received', contact_id: null, from_name: null,
  trust_level_at_time: 'unknown', routing_mode_used: 'ai_handle_first', routing_rule_id: null,
  ai_decision_reason: 'Synthetic verified policy', scam_detected: false, scam_type: null, scam_confidence: 0 };
type Row = Record<string, unknown>;
type Call = { table: string; url: URL; method: string; body: Row | null; signal: AbortSignal | null | undefined };
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: Row, url: URL) {
  return [...url.searchParams].every(([key, filter]) => {
    if (filter.startsWith('eq.')) return String(row[key]) === filter.slice(3);
    if (filter === 'is.null') return row[key] === null;
    if (filter.startsWith('cs.')) return Object.entries(JSON.parse(filter.slice(3)) as Row)
      .every(([field, value]) => JSON.stringify((row[key] as Row)?.[field]) === JSON.stringify(value));
    return true;
  });
}
function fixture() {
  const state = {
    tables: { ai_tool_calls: [], guardian_communications: [], guardian_callback_events: [], notifications: [] } as Record<string, Row[]>,
    calls: [] as Call[], fail: '' as string, count: {} as Record<string, number | null>, response: {} as Record<string, unknown>,
    before: undefined as ((call: Call) => void) | undefined, after: undefined as ((call: Call) => void) | undefined,
    lost: false, missing: false, hold: '' as string, release: undefined as (() => void) | undefined,
  };
  const client = createClient<Database>('https://guardian-completion-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').pop()!;
      if (!(table in state.tables)) throw new Error('Unexpected completion fixture table');
      const call: Call = { table, url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal };
      state.calls.push(call);
      const execute = () => {
        state.before?.(call);
        if (state.fail === `${call.method}:${table}`) return Response.json({ code: '42501', message: 'Synthetic unavailable' }, { status: 503 });
        if (call.method === 'POST') {
          state.tables[table].push({ ...clone(call.body), created_at: NOW, updated_at: NOW });
          return Response.json([{ id: call.body?.id }], { status: 201 });
        }
        const found = state.tables[table].filter(row => matches(row, url));
        if (call.method === 'PATCH') {
          for (const row of found) Object.assign(row, clone(call.body));
          state.after?.(call);
          if (state.lost) throw new Error('Synthetic committed response loss');
          return Response.json(state.missing ? null : found.map(row => ({ id: row.id })));
        }
        if (call.method !== 'GET') throw new Error('Unexpected completion fixture method');
        const count = table in state.count ? state.count[table] : found.length;
        return Response.json(table in state.response ? state.response[table] : found,
          { headers: count === null ? {} : { 'content-range': `0-${Math.max(0, found.length - 1)}/${count}` } });
      };
      if (state.hold === `${call.method}:${table}`) return new Promise<Response>((resolve, reject) => {
        state.release = () => { try { resolve(execute()); } catch (error) { reject(error); } };
      });
      return execute();
    } },
  });
  return { client, state };
}
async function ready(decision = DECISION, input = INPUT) {
  const f = fixture();
  const capture = await captureGuardianSmsReceipt(f.client, input, COMM);
  const receipt = await saveGuardianSmsDecision(f.client, capture, decision);
  f.state.tables.guardian_communications.push({ id: COMM, family_id: FAMILY, member_id: MEMBER, comm_type: 'sms_inbound',
    direction: 'inbound', from_number: input.from, to_number: input.to, body: input.body, twilio_sms_sid: input.smsSid, ...decision });
  f.state.tables.guardian_callback_events.push({ event_id: input.smsSid, callback_type: 'inbound_sms', status: 'processed',
    received_at: NOW, processed_at: NOW, error: null });
  const preview = input.body.length > 100 ? `${input.body.slice(0, 100)}…` : input.body;
  f.state.tables.notifications.push({ id: guardianSmsNotificationId(receipt.id), family_id: FAMILY, user_id: null, type: 'system',
    title: `💬 Text from ${decision.from_name ?? (input.from === null ? 'Unknown' : '(555) 555-0200')}`.trim(),
    body: preview.trim() || null, related_type: 'guardian_communications', related_id: COMM });
  f.state.calls.length = 0;
  return { ...f, receipt };
}
const unavailable = (promise: Promise<unknown>) => expect(promise).rejects.toEqual(new GuardianSmsReceiptUnavailableError());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Guardian completion with the installed PostgREST transport', () => {
  it('reads a legacy captured or decided receipt by ID without trusting a scanned payload', async () => {
    const { client } = fixture();
    const capture = await captureGuardianSmsReceipt(client, INPUT, COMM);
    expect(guardianSmsReceiptId(INPUT.smsSid)).toBe(capture.id);
    expect(guardianSmsReceiptId(INPUT.smsSid.toLowerCase())).toBe(capture.id);
    expect(() => guardianSmsReceiptId('not-a-provider-sid')).toThrow();
    expect(capture).toMatchObject({ phase: 'captured', completedAt: null });
    expect(await readGuardianSmsReceiptById(client, capture.id)).toEqual(capture);
    const receipt = await saveGuardianSmsDecision(client, capture, DECISION);
    expect(receipt).toMatchObject({ phase: 'decided', completedAt: null });
    expect(await readGuardianSmsReceiptById(client, receipt.id)).toEqual(receipt);
    expect(await readGuardianSmsReceiptById(client, OTHER)).toBeNull();
    await unavailable(readGuardianSmsReceiptById(client, 'not-a-uuid'));
  });
  it.each(['id', 'actor_kind', 'family_id', 'inputs', 'outputs'])('rejects an altered by-ID %s receipt', async key => {
    const { client, state, receipt } = await ready();
    state.response.ai_tool_calls = [{ ...state.tables.ai_tool_calls[0], [key]: key === 'id' || key === 'family_id' ? OTHER : 'altered' }];
    await unavailable(readGuardianSmsReceiptById(client, receipt.id));
    expect(state.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('marks completion only after exact communication, processed callback and family notification reads', async () => {
    const { client, state, receipt } = await ready();
    const completed = await markGuardianSmsCompleted(client, receipt);
    expect(completed).toMatchObject({ id: receipt.id, input: INPUT, communicationId: COMM, decision: DECISION, phase: 'completed', completedAt: expect.any(String) });
    expect(completed.revision).not.toBe(receipt.revision);
    expect(state.tables.ai_tool_calls[0]).toMatchObject({ state: 'succeeded', attempt: 1 });
    const patch = state.calls.findIndex(call => call.method === 'PATCH');
    for (const table of ['guardian_communications', 'guardian_callback_events', 'notifications']) {
      expect(state.calls.findIndex(call => call.table === table)).toBeLessThan(patch);
    }
    expect(await readGuardianSmsReceipt(client, INPUT)).toEqual(completed);
    expect(await readGuardianSmsReceiptById(client, receipt.id)).toEqual(completed);
    expect(await markGuardianSmsCompleted(client, receipt)).toEqual(completed);
    expect(await markGuardianSmsCompleted(client, completed)).toEqual(completed);
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('does not replace a completed decision', async () => {
    const { client, receipt } = await ready();
    const completed = await markGuardianSmsCompleted(client, receipt);
    await unavailable(saveGuardianSmsDecision(client, completed, { ...DECISION, routing_mode_used: 'blocked' }));
    expect(await readGuardianSmsReceiptById(client, receipt.id)).toEqual(completed);
  });
  it.each(['status', 'routing', 'scam'] as const)('requires no notification for a %s-blocked decision', async mode => {
    const decision = { ...DECISION, ...(mode === 'status' ? { status: 'blocked' as const }
      : mode === 'routing' ? { routing_mode_used: 'blocked' as const } : { scam_detected: true, scam_confidence: 80 }) };
    const { client, state, receipt } = await ready(decision);
    state.tables.notifications = [];
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
    expect(state.calls.some(call => call.table === 'notifications')).toBe(false);
  });
  it('requires a notification below the scam blocking threshold', async () => {
    const { client, state, receipt } = await ready({ ...DECISION, scam_detected: true, scam_confidence: 79 });
    state.tables.notifications = [];
    await unavailable(markGuardianSmsCompleted(client, receipt));
  });
  it('accepts exactly one matching legacy notification without a new notification write', async () => {
    const { client, state, receipt } = await ready(); state.tables.notifications[0].id = OTHER;
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
    expect(state.calls.every(call => call.table !== 'notifications' || call.method === 'GET')).toBe(true);
  });
  it('accepts the trimmed title of a legacy notification for a contact with trailing whitespace', async () => {
    const { client, state, receipt } = await ready({ ...DECISION, from_name: 'Dentist  ' });
    state.tables.notifications[0].id = OTHER;
    expect(state.tables.notifications[0].title).toBe('💬 Text from Dentist');
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
  });
  it.each(['', '   ', '  ' + 'x'.repeat(120)])('matches the actual stored preview for body %j', async body => {
    const { client, receipt } = await ready(DECISION, { ...INPUT, body, from: null });
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
  });
  it.each(['id', 'family_id', 'member_id', 'comm_type', 'direction', 'from_number', 'to_number', 'body', 'twilio_sms_sid',
    ...Object.keys(DECISION)])('rejects changed communication %s before completion', async key => {
    const { client, state, receipt } = await ready(); state.tables.guardian_communications[0][key] = 'altered';
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
  it.each(['event_id', 'callback_type', 'status', 'error', 'received_at', 'processed_at'])('rejects changed callback %s', async key => {
    const { client, state, receipt } = await ready(); state.tables.guardian_callback_events[0][key] = 'altered';
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
  it.each(['id', 'family_id', 'user_id', 'type', 'title', 'body', 'related_type', 'related_id'])('rejects wrong notification %s', async key => {
    const { client, state, receipt } = await ready(); state.tables.notifications[0][key] = 'altered';
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
  for (const table of ['ai_tool_calls', 'guardian_communications', 'guardian_callback_events', 'notifications']) {
    it.each(['outage', 'missing', 'missing count', 'incomplete count', 'duplicate', 'nonarray'])(`${table} %s cannot authorize completion`, async mode => {
      const { client, state, receipt } = await ready();
      if (mode === 'outage') state.fail = `GET:${table}`;
      if (mode === 'missing') state.tables[table] = [];
      if (mode === 'missing count') state.count[table] = null;
      if (mode === 'incomplete count') state.count[table] = 2;
      if (mode === 'duplicate') state.tables[table].push(clone(state.tables[table][0]));
      if (mode === 'nonarray') state.response[table] = state.tables[table][0];
      await unavailable(markGuardianSmsCompleted(client, receipt));
      expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
    });
  }
  it.each(['phase', 'completedAt', 'communicationId', 'revision', 'decision', 'input', 'id'])('refuses an altered caller %s', async key => {
    const { client, state, receipt } = await ready();
    const altered = { ...receipt, [key]: key === 'decision' ? { ...DECISION, status: 'blocked' } : key === 'input' ? { ...INPUT, body: 'other' } : OTHER } as GuardianSmsReceipt;
    await unavailable(markGuardianSmsCompleted(client, altered));
    expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
  it.each(['lost', 'missing'])('reconciles terminal transition after a %s response', async mode => {
    const { client, state, receipt } = await ready(); state.lost = mode === 'lost'; state.missing = mode === 'missing';
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('retains nonterminal work when completion was not written', async () => {
    const { client, state, receipt } = await ready(); state.fail = 'PATCH:ai_tool_calls';
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.tables.ai_tool_calls[0].outputs).toMatchObject({ phase: 'decided' });
  });
  it('recovers a committed completion after readback outage without another write', async () => {
    const { client, state, receipt } = await ready();
    state.after = () => { state.fail = 'GET:ai_tool_calls'; };
    await unavailable(markGuardianSmsCompleted(client, receipt));
    state.fail = ''; state.after = undefined;
    expect((await markGuardianSmsCompleted(client, receipt)).phase).toBe('completed');
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('does not overwrite a competing revision', async () => {
    const { client, state, receipt } = await ready();
    state.before = call => { if (call.method === 'PATCH') (state.tables.ai_tool_calls[0].outputs as Row).revision = OTHER; };
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.tables.ai_tool_calls[0].outputs).toMatchObject({ phase: 'decided', revision: OTHER });
  });
  it.each(['actor_kind', 'resource_id', 'idempotency_key', 'requested_by'])('fences altered %s at the mutation', async key => {
    const { client, state, receipt } = await ready();
    state.before = call => { if (call.method === 'PATCH') state.tables.ai_tool_calls[0][key] = OTHER; };
    await unavailable(markGuardianSmsCompleted(client, receipt));
    expect(state.tables.ai_tool_calls[0].outputs).toMatchObject({ phase: 'decided' });
  });
  it('derives a stable per-receipt notification UUID without exposing payloads in URLs', async () => {
    const { client, state, receipt } = await ready(DECISION, { ...INPUT, body: '家庭🙂'.repeat(1024) });
    expect(guardianSmsNotificationId(receipt.id)).toBe(guardianSmsNotificationId(receipt.id.toUpperCase()));
    expect(guardianSmsNotificationId(receipt.id)).not.toBe(guardianSmsNotificationId(OTHER));
    await markGuardianSmsCompleted(client, receipt);
    for (const call of state.calls) expect(call.url.toString()).not.toContain(encodeURIComponent('家庭'));
  });
  it.each(['GET:guardian_communications', 'GET:notifications', 'PATCH:ai_tool_calls'])('settles %s even when transport ignores abort, without late continuation', async hold => {
    vi.useFakeTimers();
    const { client, state, receipt } = await ready(); state.hold = hold;
    const attempt = markGuardianSmsCompleted(client, receipt);
    const checked = unavailable(attempt);
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
    const count = state.calls.length;
    expect(state.calls.find(call => `${call.method}:${call.table}` === hold)?.signal?.aborted).toBe(true);
    state.release?.(); await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(count);
    if (hold.startsWith('GET')) expect(state.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
  it('rejects a pre-aborted call without touching any table', async () => {
    const { client, state, receipt } = await ready(); const controller = new AbortController(); controller.abort();
    await unavailable(markGuardianSmsCompleted(client, receipt, { signal: controller.signal }));
    expect(state.calls).toEqual([]);
  });
});
