import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  captureGuardianSmsReceipt, readGuardianSmsReceipt, saveGuardianSmsDecision, GuardianSmsReceiptUnavailableError,
  type GuardianSmsReceiptInput, type GuardianSmsDecision,
} from '@/lib/guardian/sms-receipt';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const COMM = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-09-12T19:00:00.000Z';
const INPUT: GuardianSmsReceiptInput = { smsSid: `SM${'a'.repeat(32)}`, familyId: FAMILY, memberId: MEMBER, from: '+15555550200', to: '+15555550100', body: 'Synthetic dentist appointment tomorrow' };
const DECISION: GuardianSmsDecision = { status: 'received', contact_id: null, from_name: null, trust_level_at_time: 'known_contact', routing_mode_used: 'ai_handle_first', routing_rule_id: null, ai_decision_reason: 'Synthetic fresh policy result', scam_detected: false, scam_type: null, scam_confidence: 0 };
type Row = Record<string, unknown>;
type Call = { url: URL; method: string; body: Row | null; signal?: AbortSignal | null; headers: Headers };
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, url: URL) {
  for (const [key, value] of url.searchParams) {
    if (value.startsWith('eq.') && String(row[key]) !== value.slice(3)) return false;
    if (value === 'is.null' && row[key] !== null) return false;
    if (value.startsWith('cs.')) {
      const expected = JSON.parse(value.slice(3)) as Row, actual = row[key] as Row;
      if (!actual || Object.entries(expected).some(([field, target]) => actual[field] !== target)) return false;
    }
  }
  return true;
}
function fixture() {
  const state = {
    rows: [] as Row[], calls: [] as Call[], failure: null as 'GET' | 'POST' | 'PATCH' | null,
    lostInsert: false, lostUpdate: false, missingMutationReceipt: false,
    count: undefined as number | null | undefined, response: undefined as unknown,
    beforePatch: undefined as (() => void) | undefined,
    afterInsert: undefined as (() => void) | undefined,
    hold: null as 'GET' | 'POST' | 'PATCH' | null,
    release: undefined as (() => void) | undefined,
  };
  const client = createClient<Database>('https://guardian-receipt-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const call: Call = { url: new URL(String(raw)), method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal, headers: new Headers(init.headers) };
      state.calls.push(call);
      if (!call.url.pathname.endsWith('/ai_tool_calls')) throw new Error('Unexpected receipt fixture table');
      const execute = () => {
        if (state.failure === call.method) return Response.json({ code: '42501', message: 'Synthetic ledger unavailable' }, { status: 503, headers: { 'retry-after': '0' } });
        if (call.method === 'POST') {
          if (state.rows.some(row => row.id === call.body?.id)) return Response.json({ code: '23505', message: 'Synthetic unique receipt' }, { status: 409 });
          state.rows.push({ ...copy(call.body), created_at: NOW, updated_at: NOW });
          state.afterInsert?.();
          if (state.lostInsert) throw new Error('Synthetic response lost after capture');
          return Response.json(state.missingMutationReceipt ? null : [{ id: call.body?.id }], { status: 201 });
        }
        if (call.method === 'PATCH') {
          state.beforePatch?.();
          const found = state.rows.filter(row => matches(row, call.url));
          for (const row of found) Object.assign(row, copy(call.body));
          if (state.lostUpdate) throw new Error('Synthetic response lost after decision');
          return Response.json(state.missingMutationReceipt ? null : found.map(row => ({ id: row.id })));
        }
        if (call.method !== 'GET') throw new Error('Unexpected receipt fixture operation');
        const found = state.rows.filter(row => matches(row, call.url));
        const count = state.count === undefined ? found.length : state.count;
        return Response.json(state.response === undefined ? found : state.response, { headers: count === null ? {} : { 'content-range': `0-${Math.max(0, found.length - 1)}/${count}` } });
      };
      if (state.hold === call.method) return new Promise<Response>((resolve, reject) => {
        state.release = () => { try { resolve(execute()); } catch (error) { reject(error); } };
      });
      return execute();
    } },
  });
  return { client, state };
}
function assertUnavailable(promise: Promise<unknown>) { return expect(promise).rejects.toEqual(new GuardianSmsReceiptUnavailableError()); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Guardian SMS authored receipts through the installed PostgREST SDK', () => {
  it('distinguishes verified absence from unavailable storage', async () => {
    const { client, state } = fixture();
    expect(await readGuardianSmsReceipt(client, INPUT)).toBeNull();
    state.failure = 'GET';
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
    expect(state.calls).toHaveLength(2);
  });
  it('captures only authenticated payload identity, never an existing communication classification', async () => {
    const { client, state } = fixture();
    const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    expect(receipt).toMatchObject({ input: INPUT, communicationId: COMM, decision: null });
    expect(state.rows[0]).toMatchObject({ tool_name: 'guardian.sms_intake', actor_kind: 'system', family_id: FAMILY,
      inputs: { version: 1, ...INPUT, communicationId: COMM }, outputs: { version: 1, phase: 'captured', decision: null },
      resource_table: 'guardian_communications', resource_id: COMM, state: 'reserved', attempt: 0 });
    expect(state.calls.every(call => call.url.pathname.endsWith('/ai_tool_calls'))).toBe(true);
    expect(await captureGuardianSmsReceipt(client, INPUT, COMM)).toEqual(receipt);
    expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(await readGuardianSmsReceipt(client, INPUT)).toEqual(receipt);
  });
  it('retains one deterministic SID identity across clients and refuses a different pointer', async () => {
    const first = fixture(), second = fixture();
    const a = await captureGuardianSmsReceipt(first.client, INPUT, COMM);
    const b = await captureGuardianSmsReceipt(second.client, INPUT, COMM);
    expect(a.id).toBe(b.id);
    expect(a.revision).not.toBe(b.revision);
    await assertUnavailable(captureGuardianSmsReceipt(first.client, INPUT, OTHER));
    expect(first.state.rows[0].resource_id).toBe(COMM);
    expect(first.state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it.each(['smsSid', 'familyId', 'memberId', 'from', 'to', 'body'] as const)('never reuses a receipt for different signed %s', async field => {
    const { client, state } = fixture();
    await captureGuardianSmsReceipt(client, INPUT, COMM);
    const other = { ...INPUT, [field]: field === 'smsSid' ? INPUT.smsSid.toLowerCase() : field.endsWith('Id') ? OTHER : field === 'body' ? 'Different message' : '+15555550999' };
    await assertUnavailable(readGuardianSmsReceipt(client, other));
    await assertUnavailable(captureGuardianSmsReceipt(client, other, COMM));
    expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it.each(['missing count', 'incomplete count', 'non-array', 'null', 'duplicate'])('rejects %s read receipts', async mode => {
    const { client, state } = fixture();
    await captureGuardianSmsReceipt(client, INPUT, COMM);
    if (mode === 'missing count') state.count = null;
    if (mode === 'incomplete count') state.count = 2;
    if (mode === 'non-array') state.response = state.rows[0];
    if (mode === 'null') state.response = null;
    if (mode === 'duplicate') state.rows.push(copy(state.rows[0]));
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
  });
  it('rejects a successful lookup returning the wrong receipt ID', async () => {
    const { client, state } = fixture(); await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.response = [{ ...copy(state.rows[0]), id: OTHER }];
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
  });

  it.each([
    ['actor_kind', 'member'], ['family_id', OTHER], ['tool_name', 'another.tool'], ['idempotency_key', 'other-key'],
    ['resource_table', 'family_inbox_messages'], ['resource_id', OTHER], ['state', 'succeeded'], ['attempt', 1],
    ['requested_by', OTHER], ['requested_by_member_id', OTHER], ['run_id', OTHER], ['plan_step_id', OTHER], ['request_id', OTHER],
    ['conversation_id', OTHER], ['message_id', OTHER], ['locked_at', NOW], ['duration_ms', 1], ['error', 'changed'],
    ['finished_at', NOW], ['created_at', 'bad-date'], ['updated_at', null],
  ])('rejects altered %s metadata without writing', async (field, value) => {
    const { client, state } = fixture();
    const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.rows[0][field as string] = value;
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, DECISION));
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });
  it.each(['version', 'communicationId', 'body', 'familyId', 'extra'])('rejects altered stored input %s', async field => {
    const { client, state } = fixture();
    await captureGuardianSmsReceipt(client, INPUT, COMM);
    (state.rows[0].inputs as Row)[field] = field === 'version' ? 2 : field.endsWith('Id') ? OTHER : 'altered';
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
  });
  it.each(['version', 'revision', 'phase', 'decision', 'extra'])('rejects altered captured output %s', async field => {
    const { client, state } = fixture();
    await captureGuardianSmsReceipt(client, INPUT, COMM);
    (state.rows[0].outputs as Row)[field] = field === 'version' ? 2 : field === 'decision' ? DECISION : 'altered';
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT));
  });
  it.each(['lost response', 'missing response'])('recovers capture after %s by exact durable readback', async mode => {
    const { client, state } = fixture();
    state.lostInsert = mode === 'lost response'; state.missingMutationReceipt = mode === 'missing response';
    const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    expect(receipt.communicationId).toBe(COMM); expect(receipt.decision).toBeNull();
    expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('retains capture when its readback is unavailable and recovers it on the next attempt', async () => {
    const { client, state } = fixture();
    state.afterInsert = () => { state.failure = 'GET'; };
    await assertUnavailable(captureGuardianSmsReceipt(client, INPUT, COMM));
    expect(state.rows).toHaveLength(1);
    state.failure = null;
    expect((await captureGuardianSmsReceipt(client, INPUT, COMM)).decision).toBeNull();
    expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('does not report an uncommitted capture as saved', async () => {
    const { client, state } = fixture(); state.failure = 'POST';
    await assertUnavailable(captureGuardianSmsReceipt(client, INPUT, COMM));
    expect(state.rows).toEqual([]);
  });
  it('saves a full decision once, before any communication can be updated', async () => {
    const { client, state } = fixture();
    const capture = await captureGuardianSmsReceipt(client, INPUT, COMM);
    const decided = await saveGuardianSmsDecision(client, capture, DECISION);
    expect(decided).toMatchObject({ id: capture.id, input: INPUT, communicationId: COMM, decision: DECISION });
    expect(decided.revision).not.toBe(capture.revision);
    expect(state.rows[0]).toMatchObject({ state: 'succeeded', attempt: 1, finished_at: expect.any(String) });
    expect(await saveGuardianSmsDecision(client, capture, DECISION)).toEqual(decided);
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    const update = state.calls.find(call => call.method === 'PATCH')!;
    expect(JSON.parse(update.url.searchParams.get('outputs')!.slice(3))).toEqual({ version: 1, phase: 'captured', revision: capture.revision, decision: null });
  });
  it.each(['lost response', 'missing response'])('reconciles a committed decision after %s', async mode => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.lostUpdate = mode === 'lost response'; state.missingMutationReceipt = mode === 'missing response';
    expect((await saveGuardianSmsDecision(client, receipt, DECISION)).decision).toEqual(DECISION);
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('preserves captured input after an uncommitted decision failure', async () => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.failure = 'PATCH'; await assertUnavailable(saveGuardianSmsDecision(client, receipt, DECISION));
    expect((state.rows[0].outputs as Row).decision).toBeNull();
    state.failure = null;
    expect((await saveGuardianSmsDecision(client, receipt, DECISION)).decision).toEqual(DECISION);
  });
  it.each(['communicationId', 'input', 'id', 'revision', 'decision'])('rejects an altered caller receipt %s before mutation', async field => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    const altered = { ...receipt, [field]: field === 'communicationId' || field === 'id' || field === 'revision' ? OTHER : field === 'input' ? { ...INPUT, body: 'other' } : DECISION };
    await assertUnavailable(saveGuardianSmsDecision(client, altered, DECISION));
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });
  it.each(['status', 'contact_id', 'from_name', 'trust_level_at_time', 'routing_mode_used', 'routing_rule_id', 'ai_decision_reason', 'scam_detected', 'scam_type', 'scam_confidence'] as const)('never replaces a different trusted %s decision', async field => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    await saveGuardianSmsDecision(client, receipt, DECISION);
    const values = { status: 'blocked', contact_id: OTHER, from_name: 'Other contact', trust_level_at_time: 'unknown', routing_mode_used: 'blocked', routing_rule_id: OTHER, ai_decision_reason: 'other reason', scam_detected: true, scam_type: 'phishing', scam_confidence: 99 };
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, { ...DECISION, [field]: values[field] } as GuardianSmsDecision));
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    expect((state.rows[0].outputs as Row).decision).toEqual(DECISION);
  });
  it('rejects a concurrent revision change instead of overwriting it', async () => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.beforePatch = () => { (state.rows[0].outputs as Row).revision = OTHER; };
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, DECISION));
    expect(state.rows[0]).toMatchObject({ state: 'reserved', outputs: { revision: OTHER, decision: null } });
  });
  it('preserves a competing trusted decision and permits verified replay of that winner', async () => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    const winner = { ...DECISION, routing_mode_used: 'blocked', status: 'blocked' } as GuardianSmsDecision;
    state.beforePatch = () => { Object.assign(state.rows[0], { state: 'succeeded', attempt: 1, finished_at: NOW,
      outputs: { version: 1, phase: 'decided', revision: OTHER, decision: winner } }); };
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, DECISION));
    expect((await readGuardianSmsReceipt(client, INPUT))?.decision).toEqual(winner);
  });
  it('rechecks pointer and metadata after a decision mutation', async () => {
    const { client, state } = fixture(); const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.beforePatch = () => { state.rows[0].resource_id = OTHER; (state.rows[0].inputs as Row).communicationId = OTHER; };
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, DECISION));
    expect((state.rows[0].outputs as Row).decision).toBeNull();
  });
  it('retains the complete permitted Unicode body without putting it in GET/PATCH URLs', async () => {
    const { client, state } = fixture(); const input = { ...INPUT, body: '家庭🙂'.repeat(1024) };
    const receipt = await captureGuardianSmsReceipt(client, input, COMM); await saveGuardianSmsDecision(client, receipt, DECISION);
    expect((state.rows[0].inputs as Row).body).toBe(input.body);
    expect(state.calls.every(call => !decodeURIComponent(call.url.href).includes(input.body) && !call.url.searchParams.has('inputs'))).toBe(true);
  });
  it('contains invalid input and decision shapes before any write', async () => {
    const { client, state } = fixture();
    await assertUnavailable(captureGuardianSmsReceipt(client, { ...INPUT, body: 'x'.repeat(4097) }, COMM));
    expect(state.calls).toHaveLength(0);
    const receipt = await captureGuardianSmsReceipt(client, INPUT, COMM);
    await assertUnavailable(saveGuardianSmsDecision(client, receipt, { ...DECISION, scam_confidence: Number.NaN }));
    expect(state.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });
  it('does no work when the caller already aborted', async () => {
    const { client, state } = fixture(); const controller = new AbortController(); controller.abort();
    await assertUnavailable(readGuardianSmsReceipt(client, INPUT, { signal: controller.signal }));
    expect(state.calls).toHaveLength(0);
  });
  it('shares its deadline across capture lookup and write rather than restarting the budget', async () => {
    vi.useFakeTimers();
    const { client, state } = fixture(); state.hold = 'GET';
    const completed = vi.fn();
    const result = captureGuardianSmsReceipt(client, INPUT, COMM).then(completed, error => error);
    await vi.advanceTimersByTimeAsync(4000);
    state.hold = 'POST'; state.release?.(); await vi.advanceTimersByTimeAsync(0);
    expect(state.calls.at(-1)?.method).toBe('POST');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toEqual(new GuardianSmsReceiptUnavailableError());
    state.release?.(); await vi.advanceTimersByTimeAsync(1);
    expect(completed).not.toHaveBeenCalled();
    expect(state.calls.filter(call => call.method === 'GET')).toHaveLength(1);
  });
  it.each(['GET', 'POST', 'PATCH'] as const)('settles and aborts %s even when transport ignores cancellation; late success cannot resume caller', async method => {
    vi.useFakeTimers();
    const { client, state } = fixture();
    const receipt = method === 'POST' ? null : await captureGuardianSmsReceipt(client, INPUT, COMM);
    state.hold = method;
    const completed = vi.fn();
    const result = (method === 'GET' ? readGuardianSmsReceipt(client, INPUT)
      : method === 'POST' ? captureGuardianSmsReceipt(client, INPUT, COMM)
      : saveGuardianSmsDecision(client, receipt!, DECISION)).then(completed, error => error);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual(new GuardianSmsReceiptUnavailableError());
    expect(state.calls.at(-1)?.signal?.aborted).toBe(true);
    state.release?.(); await vi.advanceTimersByTimeAsync(1);
    expect(completed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    state.hold = null;
    const saved = await readGuardianSmsReceipt(client, INPUT);
    expect(saved?.decision).toEqual(method === 'PATCH' ? DECISION : null);
  });
});
