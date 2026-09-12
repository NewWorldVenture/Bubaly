import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { readSmsReplyStatuses } from '@/lib/contact-center/sms-reply-status';
import { smsReplyReceiptId, smsReplyOutboundId, smsReplyOutboundRef, validateSmsReplyReceipt } from '@/lib/contact-center/sms-reply';

const mocks = vi.hoisted(() => ({ context: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requirePlanLevel: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
const FAMILY = '11111111-1111-4111-8111-111111111111', FOREIGN = '22222222-2222-4222-8222-222222222222';
const INBOUND = '33333333-3333-4333-8333-333333333333', REVISION = '44444444-4444-4444-8444-444444444444';
const SID = `SM${'a'.repeat(32)}`, NOW = '2026-09-12T12:00:00.000Z';
type Row = Record<string, unknown>;
type Message = Parameters<typeof readSmsReplyStatuses>[0][number];
type StoredMessage = Message & { family_id: string; provider_ref: string | null; ai_handled: boolean };
type Phase = 'queued' | 'emission_reserved' | 'suppressed' | 'legacy_unknown';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const copy = <T>(value: T): T => structuredClone(value);
function fixture(phase: Phase = 'queued') {
  const id = smsReplyReceiptId(FAMILY, SID), terminal = ['suppressed', 'legacy_unknown'].includes(phase), reserved = phase === 'emission_reserved';
  const binding = { familyId: FAMILY, channelId: FAMILY, smsSid: SID, from: '+15555550101', to: '+15555550202', body: 'Private inbound fixture' };
  const candidate = { summary: 'Fixture summary', intent: 'other', reply: phase === 'legacy_unknown' ? null : 'Private reply fixture', locale: 'en-US', suppression: null };
  const inbox: StoredMessage[] = [{ id: INBOUND, family_id: FAMILY, channel: 'sms', direction: 'inbound', from_addr: binding.from, to_addr: binding.to,
    subject: null, body: binding.body, ai_summary: candidate.summary, ai_intent: candidate.intent, ai_handled: false, status: 'new', provider_ref: SID, occurred_at: NOW }];
  const outbound: StoredMessage = { id: smsReplyOutboundId(id), family_id: FAMILY, channel: 'sms', direction: 'outbound', from_addr: binding.to, to_addr: binding.from,
    subject: null, body: candidate.reply ?? '', ai_summary: null, ai_intent: null, ai_handled: true, status: 'read', provider_ref: smsReplyOutboundRef(id), occurred_at: NOW };
  if (reserved) inbox.push(outbound);
  const receipt: Row = { id, family_id: FAMILY, tool_name: 'contact_center.sms_reply', actor_kind: 'system',
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
    inputs: { version: 1, policyVersion: 1, binding, candidate, fingerprint: hash(JSON.stringify({ binding, candidate })) },
    outputs: { version: 1, revision: REVISION, phase, inboundId: INBOUND, outboundId: reserved ? outbound.id : null,
      emissionToken: reserved ? REVISION : null, emissionReservedAt: reserved ? NOW : null, reason: phase === 'legacy_unknown' ? 'legacy' : phase === 'suppressed' ? 'disabled' : null },
    state: terminal ? 'failed' : 'reserved', attempt: reserved ? 1 : 0, locked_at: reserved ? NOW : null,
    duration_ms: null, error: null, resource_table: 'family_inbox_messages', resource_id: INBOUND,
    idempotency_key: `contact_center.sms_reply:v1:${hash(JSON.stringify([FAMILY, 'sms', SID.toLowerCase()]))}`,
    created_at: NOW, updated_at: NOW, finished_at: terminal ? NOW : null,
  };
  validateSmsReplyReceipt(receipt);
  const state = { inbox, receipts: [receipt], calls: [] as URL[], failure: '' as string, countDelta: 0, held: false, release: () => {} };
  const client = createClient<Database>('https://synthetic-status.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); state.calls.push(url);
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
      expect(init?.signal).toBeTruthy();
      const table = url.pathname.split('/').at(-1)!;
      if (table === 'ai_tool_calls') expect(url.searchParams.get('tool_name')).toBe('eq.contact_center.sms_reply');
      else expect(table).toBe('family_inbox_messages');
      const execute = () => {
        if (state.failure === table) return Response.json({ message: 'Private diagnostic fixture', code: '08006' }, { status: 503 });
        const ids = new Set((url.searchParams.get('id') ?? '').slice(4, -1).split(','));
        expect(ids.size).toBeLessThanOrEqual(200);
        expect(Number(url.searchParams.get('limit'))).toBe(ids.size + 1);
        const data = (table === 'ai_tool_calls' ? state.receipts : state.inbox).filter(row => row.family_id === FAMILY && ids.has(String(row.id)));
        return Response.json(data, { headers: { 'content-range': `0-${Math.max(0, data.length - 1)}/${data.length + state.countDelta}` } });
      };
      if (state.held) return new Promise<Response>(resolve => { state.release = () => resolve(execute()); });
      return execute();
    } },
  });
  mocks.admin.mockReturnValue(client);
  const displayed = (rows = state.inbox): readonly Message[] => copy(rows)
    .map(({ family_id: _family, provider_ref: _ref, ai_handled: _handled, ...row }) => row);
  return { state, receipt, outbound, displayed };
}
beforeEach(() => { vi.resetAllMocks(); mocks.context.mockResolvedValue({ active: { familyId: FAMILY, role: 'child' } }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('family-authorized SMS reply display through the installed PostgREST client', () => {
  it.each([['queued', 'prepared'], ['emission_reserved', 'confirmation_unknown'], ['suppressed', 'suppressed'], ['legacy_unknown', 'legacy_unknown']] as const)
   ('maps %s to a safe state without exposing the receipt', async (phase, expected) => {
      const { displayed } = fixture(phase);
      const messages = displayed(), result = await readSmsReplyStatuses(messages);
      expect(result).toEqual(Object.fromEntries(messages.map(message => [message.id, expected])));
      expect(mocks.context).toHaveBeenCalledWith(2);
      expect(JSON.stringify(result)).not.toMatch(/Private|emissionToken|revision|inputs|outputs|familyId/);
    });

  it('finds a prepared projection when its inbound message is outside the displayed page', async () => {
    const { state, outbound, displayed } = fixture(); state.inbox.push(outbound);
    expect(await readSmsReplyStatuses(displayed([outbound]))).toEqual({ [String(outbound.id)]: 'prepared' });
    expect(state.calls.filter(url => url.pathname.endsWith('family_inbox_messages'))).toHaveLength(2);
  });

  it.each(['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'] as const)
    ('shows verified provider %s only as a safe status, without the provider SID or token', async status => {
      const { receipt, displayed } = fixture('emission_reserved');
      (receipt.outputs as Row).delivery = { providerSid: `SM${'b'.repeat(32)}`, status, observedAt: NOW };
      const result = await readSmsReplyStatuses(displayed());
      expect(result).toEqual(Object.fromEntries(displayed().map(row => [row.id, status === 'queued' ? 'provider_queued' : status])));
      expect(JSON.stringify(result)).not.toMatch(/SM|observedAt|emissionToken|providerSid|Private/);
    });

  it.each(['providerSid', 'status', 'observedAt', 'extra'] as const)('does not show delivery from malformed %s evidence', async field => {
    const { receipt, displayed } = fixture('emission_reserved');
    (receipt.outputs as Row).delivery = { providerSid: `SM${'b'.repeat(32)}`, status: 'delivered', observedAt: NOW, [field]: 'malformed' };
    expect(await readSmsReplyStatuses(displayed())).toEqual(Object.fromEntries(displayed().map(row => [row.id, 'unavailable'])));
  });

  it('does not promote a prepared or legacy receipt with injected delivery fields', async () => {
    const { receipt, displayed } = fixture();
    (receipt.outputs as Row).delivery = { providerSid: `SM${'b'.repeat(32)}`, status: 'delivered', observedAt: NOW };
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'unavailable' });
  });

  it('withholds delivered status when the bound reply body changes', async () => {
    const { receipt, state, displayed } = fixture('emission_reserved');
    (receipt.outputs as Row).delivery = { providerSid: `SM${'b'.repeat(32)}`, status: 'delivered', observedAt: NOW };
    state.inbox[1].body = 'Different reply';
    expect(await readSmsReplyStatuses(displayed())).toEqual(Object.fromEntries(displayed().map(row => [row.id, 'unavailable'])));
  });

  it('keeps an old outbound row without a receipt explicitly unknown', async () => {
    const { state, outbound, displayed } = fixture(); outbound.provider_ref = null; state.inbox = [outbound]; state.receipts = [];
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [String(outbound.id)]: 'legacy_unknown' });
    expect(state.calls).toHaveLength(1);
  });

  it('keeps an old inbound row without a receipt explicitly unknown', async () => {
    const { state, displayed } = fixture(); state.receipts = [];
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'legacy_unknown' });
  });

  it('allows a verified legacy receipt whose original summary and intent were null', async () => {
    const { state, receipt, displayed } = fixture('legacy_unknown');
    state.inbox[0].ai_summary = null; state.inbox[0].ai_intent = null;
    const inputs = receipt.inputs as { binding: { body: string }; candidate: { summary: string }; fingerprint: string };
    inputs.candidate.summary = inputs.binding.body; inputs.fingerprint = hash(JSON.stringify({ binding: inputs.binding, candidate: inputs.candidate }));
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'legacy_unknown' });
  });

  it('does not read service data if family authorization fails', async () => {
    const { displayed, state } = fixture(); mocks.context.mockRejectedValue(new Error('Authorization fixture denied'));
    await expect(readSmsReplyStatuses(displayed())).rejects.toThrow('Authorization fixture denied');
    expect(mocks.admin).not.toHaveBeenCalled(); expect(state.calls).toEqual([]);
  });

  it('does not reveal a selected message that belongs to another family', async () => {
    const { state, displayed } = fixture(); state.inbox[0].family_id = FOREIGN;
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'unavailable' });
    expect(state.calls).toHaveLength(1);
  });

  it.each(['body', 'from_addr', 'to_addr', 'ai_summary'] as const)('does not label a display snapshot whose %s changed', async field => {
    const { state, displayed } = fixture(); const messages = displayed(); state.inbox[0][field] = 'Different snapshot';
    expect(await readSmsReplyStatuses(messages)).toEqual({ [INBOUND]: 'unavailable' });
    expect(state.calls).toHaveLength(1);
  });

  it.each(['body', 'from_addr', 'to_addr', 'provider_ref'] as const)('requires the exact frozen outbound %s', async field => {
    const { state, displayed } = fixture('emission_reserved'); state.inbox[1][field] = 'Different projection';
    expect((await readSmsReplyStatuses(displayed([state.inbox[0]])))[INBOUND]).toBe('unavailable');
  });

  it('does not call a receipt reserved when its bound projection is missing', async () => {
    const { state, displayed } = fixture('emission_reserved'); state.inbox.pop();
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'unavailable' });
  });

  it.each(['family_id', 'actor_kind', 'requested_by', 'resource_id'] as const)('rejects altered receipt authority at %s', async field => {
    const { receipt, displayed } = fixture(); receipt[field] = 'Altered private metadata';
    // A cross-family row filtered out by the real database cannot become display authority.
    expect((await readSmsReplyStatuses(displayed()))[INBOUND]).toBe(field === 'family_id' ? 'legacy_unknown' : 'unavailable');
  });

  it.each(['ai_tool_calls', 'family_inbox_messages'])('keeps %s read errors visible without private diagnostics', async table => {
    const { state, displayed } = fixture(); state.failure = table;
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'unavailable' });
  });

  it('rejects count truncation instead of reporting receipt absence', async () => {
    const { state, displayed } = fixture(); state.countDelta = 1;
    expect(await readSmsReplyStatuses(displayed())).toEqual({ [INBOUND]: 'unavailable' });
  });

  it('does not load statuses for other message channels', async () => {
    const { displayed, state } = fixture(); const messages = displayed().map(row => ({ ...row, channel: 'email' } as typeof row));
    expect(await readSmsReplyStatuses(messages)).toEqual({});
    expect(mocks.context).not.toHaveBeenCalled(); expect(state.calls).toEqual([]);
  });

  it('rejects oversized display selections before service queries', async () => {
    const { displayed, state } = fixture();
    expect(await readSmsReplyStatuses(Array.from({ length: 101 }, () => displayed()[0]))).toEqual({ [INBOUND]: 'unavailable' });
    expect(mocks.admin).not.toHaveBeenCalled(); expect(state.calls).toEqual([]);
  });

  it('settles an ignored-abort read deadline and does not continue with a late response', async () => {
    vi.useFakeTimers(); const { state, displayed } = fixture(); state.held = true;
    const work = readSmsReplyStatuses(displayed());
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await work).toEqual({ [INBOUND]: 'unavailable' });
    state.release(); await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toHaveLength(1);
  });
});
