import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { addUsage, recordModelCall, usageFromOpenAI } from '@/lib/ai/usage';
import { OpenAIProvider } from '@/lib/ai/provider';

afterEach(() => vi.restoreAllMocks());

describe('usageFromOpenAI', () => {
  it('reads OpenAI token counts and distinguishes "no data" from zero', () => {
    expect(usageFromOpenAI({ prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 }))
      .toEqual({ inputTokens: 120, outputTokens: 34, totalTokens: 154 });
    // Some responses omit total_tokens; deriving it keeps the meter usable.
    expect(usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 5 }))
      .toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(usageFromOpenAI(undefined)).toBeNull();
    expect(usageFromOpenAI({})).toBeNull();
    expect(usageFromOpenAI({ prompt_tokens: 'lots' })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('sums usage across the several model calls one request makes', () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { inputTokens: 10, outputTokens: 20, totalTokens: 30 }))
      .toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
    expect(addUsage(null, null)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe('OpenAIProvider captures usage off the response', () => {
  it('returns the token counts from a completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(Promise.resolve({
      ok: true,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      })),
    } as unknown as Response)));

    const completion = await new OpenAIProvider('gpt-4o', 'test-key')
      .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(completion.usage).toEqual({ inputTokens: 42, outputTokens: 7, totalTokens: 49 });
  });

  it('asks for usage on streamed runs and reports it through onUsage', async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n',
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const fetchMock = vi.fn().mockReturnValue(Promise.resolve({
      ok: true,
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }) }) },
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const seen: unknown[] = [];
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    for await (const _event of provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], onUsage: (u) => seen.push(u) })) {
      // draining the generator is the point; the events themselves are covered elsewhere
    }
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(seen).toEqual([{ inputTokens: 11, outputTokens: 2, totalTokens: 13 }]);
  });
});

/**
 * A Supabase double that records writes. `ai_requests` is read-then-updated
 * (the counters accumulate), `ai_run_events` is insert-only.
 */
function fakeSupabase(options: {
  current?: { prompt_tokens: number | null; completion_tokens: number | null; latency_ms: number | null } | null;
  readError?: unknown;
  updateError?: unknown;
  insertError?: unknown;
} = {}) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const filters: { table: string; column: string; value: unknown }[] = [];

  const db = {
    from: (table: string) => {
      if (table === 'ai_requests') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          update: (patch: Record<string, unknown>) => { updates.push(patch); return chain; },
          eq: (column: string, value: unknown) => { filters.push({ table, column, value }); return chain; },
          maybeSingle: () => Promise.resolve({ data: options.current ?? null, error: options.readError ?? null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: options.updateError ?? null }),
        };
        return chain;
      }
      if (table === 'ai_run_events') {
        return { insert: (row: Record<string, unknown>) => { events.push(row); return Promise.resolve({ data: null, error: options.insertError ?? null }); } };
      }
      throw new Error(`unmocked table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { db, updates, events, filters };
}

describe('recordModelCall', () => {
  const usage = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };

  it('accumulates tokens and latency onto the request rather than overwriting them', async () => {
    const { db, updates, filters } = fakeSupabase({ current: { prompt_tokens: 40, completion_tokens: 10, latency_ms: 900 } });

    await recordModelCall({ db, familyId: 'fam-1', requestId: 'req-1', model: 'gpt-4.1', task: 'plan', usage, latencyMs: 1200.4, ok: true });

    expect(updates).toEqual([{ model: 'gpt-4.1', prompt_tokens: 140, completion_tokens: 35, latency_ms: 2100 }]);
    // Every write is family-scoped, including the ones a cron makes with the service client.
    expect(filters.filter((f) => f.column === 'family_id')).toEqual([
      { table: 'ai_requests', column: 'family_id', value: 'fam-1' },
      { table: 'ai_requests', column: 'family_id', value: 'fam-1' },
    ]);
  });

  it('starts from zero when the request has no counters yet', async () => {
    const { db, updates } = fakeSupabase({ current: { prompt_tokens: null, completion_tokens: null, latency_ms: null } });
    await recordModelCall({ db, familyId: 'fam-1', requestId: 'req-1', model: 'gpt-4o-mini', task: 'classify', usage: null, latencyMs: 300, ok: true });
    expect(updates).toEqual([{ model: 'gpt-4o-mini', prompt_tokens: 0, completion_tokens: 0, latency_ms: 300 }]);
  });

  it('writes a metrics-only model_call event that carries no prompt text', async () => {
    const { db, events } = fakeSupabase({ current: null });

    await recordModelCall({
      db, familyId: 'fam-1', requestId: 'req-1', runId: 'run-1', stepId: 'step-1',
      model: 'gpt-4.1', task: 'plan', usage, latencyMs: 1500, ok: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      family_id: 'fam-1', run_id: 'run-1', request_id: 'req-1', step_id: 'step-1',
      event_type: 'model_call', actor_kind: 'ai', message: 'plan · gpt-4.1',
    });
    // ai_run_events is readable by every family member, so the payload is
    // limited to metrics — never prompt or context text (0250's header).
    expect(events[0].payload).toEqual({
      task: 'plan', model: 'gpt-4.1', prompt_tokens: 100, completion_tokens: 25, total_tokens: 125,
      latency_ms: 1500, ok: true, error_code: null,
    });
  });

  it('records the failure code when the model call did not succeed', async () => {
    const { db, events } = fakeSupabase({ current: null });
    await recordModelCall({ db, familyId: 'fam-1', runId: 'run-1', model: 'gpt-4.1', task: 'plan', usage: null, latencyMs: 40, ok: false, errorCode: 'rate_limit' });
    expect(events[0].message).toBe('plan · gpt-4.1 failed (rate_limit)');
    expect((events[0].payload as Record<string, unknown>).error_code).toBe('rate_limit');
  });

  it('skips both writes when there is no request and no run to attribute the call to', async () => {
    const { db, updates, events } = fakeSupabase({ current: null });
    await recordModelCall({ db, familyId: 'fam-1', model: 'gpt-4o-mini', task: 'summarize', usage, latencyMs: 10, ok: true });
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
  });

  it('logs and swallows write failures — metering must never fail a good model call', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeSupabase({ readError: { message: 'permission denied for table ai_requests' }, insertError: { message: 'insert denied' } });

    await expect(recordModelCall({
      db, familyId: 'fam-1', requestId: 'req-1', runId: 'run-1', model: 'gpt-4.1', task: 'plan', usage, latencyMs: 10, ok: true,
    })).resolves.toBeUndefined();

    const logged = err.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('[ai-usage] request usage read failed');
    expect(logged).toContain('[ai-usage] model_call event insert failed');
  });
});
