// §33: every AI surface leaves a record.
//
// "A family writes in that 'Bubaly stopped doing my Sunday meal plan' and nobody
// can answer them." `ai_requests` already had `model`, `prompt_tokens`,
// `completion_tokens`, `latency_ms` and `error`, and `recordModelCall` already
// filled them — but only when handed a `requestId`, and only the concierge
// planner ever opened a row. Of ~50 model entrypoints, five carried one.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { MAX_AI_REQUEST_TEXT_CHARS } from '@/lib/ai/chat-request';

const createRequest = vi.fn();
const updateRequest = vi.fn();
const recordModelCall = vi.fn();

vi.mock('@/lib/ai/runs/store', () => ({
  createRequest: (...a: unknown[]) => createRequest(...a),
  updateRequest: (...a: unknown[]) => updateRequest(...a),
}));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: (...a: unknown[]) => recordModelCall(...a) }));

const { withAiRequest } = await import('@/lib/ai/observability');

const scope = { db: {}, familyId: 'fam-1', userId: 'u1', memberId: 'm1', role: 'parent', actorKind: 'member', tz: 'UTC' } as unknown as ServiceScope;
const patches = () => updateRequest.mock.calls.map((c) => c[2] as Record<string, unknown>);
const closing = () => patches().at(-1) ?? {};

beforeEach(() => {
  createRequest.mockReset().mockResolvedValue({ ok: true, data: { id: 'req-1' } });
  updateRequest.mockReset().mockResolvedValue({ ok: true, data: null });
  recordModelCall.mockReset().mockResolvedValue(undefined);
});

describe('a surface that succeeds leaves a complete record', () => {
  it('opens the row, marks it executing, and closes it completed', async () => {
    const out = await withAiRequest(scope, { feature: 'briefing.morning', text: 'brief me' }, async (obs) => {
      obs.used('gpt-x', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      return 'done';
    });
    expect(out).toBe('done');
    expect(createRequest.mock.calls[0][1]).toMatchObject({ feature: 'briefing.morning', kind: 'feature' });
    expect(patches()[0]).toMatchObject({ status: 'executing' });
    expect(closing()).toMatchObject({ status: 'completed' });
    expect(closing().completed_at).toEqual(expect.any(String));
  });

  it('records which model actually answered, and what it cost', async () => {
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => {
      obs.used('gpt-x', { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });
    expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-1', familyId: 'fam-1', model: 'gpt-x', task: 'f', ok: true,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));
  });

  it('charges the latency once across several model calls', async () => {
    // recordModelCall ACCUMULATES latency per request. Reporting the elapsed time
    // against each call would multiply one request's duration by its call count.
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => {
      obs.used('a'); obs.used('b'); obs.used('c');
    });
    const latencies = recordModelCall.mock.calls.map((c) => (c[0] as { latencyMs: number }).latencyMs);
    expect(latencies.filter((ms) => ms > 0).length).toBeLessThanOrEqual(1);
    expect(latencies).toHaveLength(3);
  });
});

describe('a surface that fails leaves the diagnosis', () => {
  it('records the error and rethrows unchanged — this observes, it does not handle', async () => {
    const boom = new Error('provider exploded');
    await expect(withAiRequest(scope, { feature: 'f', text: 't' }, async () => { throw boom; })).rejects.toBe(boom);
    expect(closing()).toMatchObject({ status: 'failed', error: 'provider exploded' });
  });

  it('records a failure the surface HANDLED itself', async () => {
    // The chat assistant catches its own stream errors and falls back, so
    // nothing reaches the catch above. Without this the row would read
    // `completed` for a turn the family watched break.
    await withAiRequest(scope, { feature: 'chat.assistant', text: 't' }, async (obs) => {
      obs.failed(new Error('stream died'));
      return 'fell back';
    });
    expect(closing()).toMatchObject({ status: 'failed', error: 'stream died' });
  });

  it('calls a broken-but-answered turn partially_completed', async () => {
    await withAiRequest(scope, { feature: 'chat.assistant', text: 't' }, async (obs) => {
      obs.failed(new Error('stream died mid-sentence'), { partial: true });
    });
    expect(closing()).toMatchObject({ status: 'partially_completed' });
  });

  it('keeps the FIRST failure, not the last', async () => {
    // A surface that falls back and then fails again is still explained by what
    // broke first; the fallback's error is a consequence.
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => {
      obs.failed(new Error('the real cause'));
      obs.failed(new Error('the fallback also failed'));
    });
    expect(closing()).toMatchObject({ error: 'the real cause' });
  });

  it('still records latency when no model call was reported', async () => {
    // Failing before the provider answered is exactly the case §33 cares about,
    // and "it failed" without "how long it took" is half a diagnosis.
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => { obs.failed(new Error('x')); });
    expect(closing()).toHaveProperty('latency_ms');
  });

  it('does not set latency when a model call already accumulated it', async () => {
    // recordModelCall accumulates; writing it again here would double-count.
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => { obs.used('gpt-x'); });
    expect(closing()).not.toHaveProperty('latency_ms');
  });

  it('truncates a long provider error rather than storing it whole', async () => {
    await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => { obs.failed(new Error('x'.repeat(5000))); });
    expect(String(closing().error).length).toBeLessThanOrEqual(500);
  });
});

describe('bookkeeping never fails the family’s work', () => {
  it('runs the body with a null request id when the row cannot be opened', async () => {
    // A family losing their meal plan because an observability insert failed
    // would be the gap making itself worse.
    createRequest.mockResolvedValue({ ok: false, error: 'db down' });
    let seen: string | null | undefined;
    const out = await withAiRequest(scope, { feature: 'f', text: 't' }, async (obs) => {
      seen = obs.requestId;
      return 'still worked';
    });
    expect(out).toBe('still worked');
    expect(seen).toBeNull();
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it('survives createRequest throwing outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    createRequest.mockRejectedValue(new Error('connection reset'));
    await expect(withAiRequest(scope, { feature: 'f', text: 't' }, async () => 'ok')).resolves.toBe('ok');
  });

  it('still returns the answer when closing the row fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateRequest.mockRejectedValue(new Error('write failed'));
    await expect(withAiRequest(scope, { feature: 'f', text: 't' }, async () => 'answer')).resolves.toBe('answer');
  });

  it('still reports the body’s error when closing the row fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateRequest.mockRejectedValue(new Error('write failed'));
    const boom = new Error('the real failure');
    await expect(withAiRequest(scope, { feature: 'f', text: 't' }, async () => { throw boom; })).rejects.toBe(boom);
  });
});

describe('the row cannot be longer than the column\'s own contract', () => {
  it('truncates request text at MAX_AI_REQUEST_TEXT_CHARS, wherever the caller got it', async () => {
    // The concierge intake already caps this exact column; a surface reaching
    // `ai_requests` through the wrapper was the only way in without that cap.
    // The chat assistant's own message limit is 8000 — twice this one — so it
    // was already through it, and `travel.research` interpolated a destination
    // nothing bounded at all.
    //
    // Enforced here rather than at each caller because "keep it short" is this
    // module's documented contract, and fifteen call sites remembering a rule
    // is the same rule forgotten somewhere.
    const huge = 'x'.repeat(MAX_AI_REQUEST_TEXT_CHARS + 5_000);
    await withAiRequest(scope, { feature: 'travel.research', text: huge }, async (obs) => {
      obs.used('m', null);
      return 'ok';
    });
    const [, input] = createRequest.mock.calls[0] as [unknown, { requestText: string }];
    expect(input.requestText).toHaveLength(MAX_AI_REQUEST_TEXT_CHARS);
  });

  it('leaves a short one exactly as the caller wrote it', async () => {
    await withAiRequest(scope, { feature: 'notes.assist', text: 'Analyse a note' }, async (obs) => {
      obs.used('m', null);
      return 'ok';
    });
    const [, input] = createRequest.mock.calls[0] as [unknown, { requestText: string }];
    expect(input.requestText).toBe('Analyse a note');
  });
});

