import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// §33. The contact-center concierge answers inbound SMS, email and voicemail on
// the family's behalf with a model, and its summary reaches the family's phone.
// It recorded nothing. With `record`, the model call opens an `ai_requests`
// row on a system scope — unmetered and never refused (F19: inbound work
// nobody asked for) — and a failure is recorded before the deterministic
// fallback, which still answers the line.

const FAMILY = 'fam-1';
const state = vi.hoisted(() => ({
  configured: true,
  reply: '{"intent":"appointment","summary":"Dentist wants to move Tuesday","reply":"Thanks, we will call back."}' as string | Error,
  calls: 0,
}));
let store: InMemorySupabase;
const db = { from: (t: string) => store.from(t), rpc: async () => ({ data: null, error: { message: 'no rpc' } }) };

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 0 }));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => {} }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => state.configured,
  resolveProvider: async () => ({
    model: 'concierge-model',
    complete: async () => {
      state.calls += 1;
      if (state.reply instanceof Error) throw state.reply;
      return { text: state.reply, toolCalls: [], model: 'concierge-model' };
    },
  }),
}));

const { runConcierge } = await import('@/lib/contact-center/concierge');
const rows = () => store.table('ai_requests').filter((r: Row) => r.family_id === FAMILY);
const record = () => ({ db: db as never, familyId: FAMILY });
const inbound = { channel: 'sms' as const, from: '+15555550100', text: 'Can we move Tuesday?', familyLabel: 'The Smiths' };

beforeEach(() => {
  store = createInMemorySupabase({});
  state.configured = true;
  state.reply = '{"intent":"appointment","summary":"Dentist wants to move Tuesday","reply":"Thanks, we will call back."}';
  state.calls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the contact-center concierge records its model call', () => {
  it('an answered SMS opens one unmetered row on a system scope, settled completed', async () => {
    const result = await runConcierge({ ...inbound, record: record() });
    expect(result).toMatchObject({ intent: 'appointment', aiUsed: true });
    expect(rows()).toEqual([expect.objectContaining({
      feature: 'contact-center.sms', request_text: 'Answer an inbound message', requested_by: null, metered: false, status: 'completed',
    })]);
  });

  it('at 10 of 10 on Free the line still answers with the model, and the row does not count', async () => {
    store.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({ family_id: FAMILY, kind: 'feature', feature: 'notes.summary', status: 'completed', request_text: `paid ${i}` })));
    const result = await runConcierge({ ...inbound, channel: 'email', record: record() });
    expect(result.aiUsed).toBe(true);
    expect(state.calls).toBe(1);
    expect(rows().filter((r: Row) => r.metered === true)).toHaveLength(10);
    expect(rows().at(-1)).toMatchObject({ feature: 'contact-center.email', metered: false });
  });

  it('a model failure is recorded as failed, and the deterministic fallback still answers', async () => {
    state.reply = new Error('upstream 500');
    const result = await runConcierge({ ...inbound, channel: 'voice', record: record() });
    expect(result.aiUsed).toBe(false);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(rows()).toEqual([expect.objectContaining({ feature: 'contact-center.voice', status: 'failed' })]);
    expect(String(rows()[0].error)).toContain('upstream 500');
  });

  it('an unparseable answer is a failure for the record too, and falls back', async () => {
    state.reply = 'not json';
    const result = await runConcierge({ ...inbound, record: record() });
    expect(result.aiUsed).toBe(false);
    expect(rows()).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('control: without record the call runs as before and files nothing', async () => {
    const result = await runConcierge(inbound);
    expect(result.aiUsed).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('control: AI not configured, or an already-aborted call, opens no row', async () => {
    state.configured = false;
    await runConcierge({ ...inbound, record: record() });
    state.configured = true;
    await runConcierge({ ...inbound, signal: AbortSignal.abort(), record: record() });
    expect(rows()).toHaveLength(0);
    expect(state.calls).toBe(0);
  });
});
