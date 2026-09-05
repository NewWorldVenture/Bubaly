import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  isRetryableProviderError,
  providerErrorStatus,
  RetryAbortedError,
  withBackoff,
} from '@/lib/ai/retry';
import { OpenAIProvider, STREAM_INTERRUPTED_AFTER_ACTIONS, type StreamEvent, type ToolSpec } from '@/lib/ai/provider';

afterEach(() => vi.restoreAllMocks());

// Deterministic test doubles: no real sleeping, no real jitter.
const noSleep = () => Promise.resolve();
const fullJitter = () => 1;

describe('provider error classification', () => {
  it('reads the status off both the message and a numeric status property', () => {
    expect(providerErrorStatus(new Error('OpenAI error 429: Rate limit reached'))).toBe(429);
    expect(providerErrorStatus(Object.assign(new Error('boom'), { status: 503 }))).toBe(503);
    expect(providerErrorStatus(new Error('fetch failed'))).toBeNull();
  });

  it('retries rate limits, 5xx and transport faults', () => {
    expect(isRetryableProviderError(new Error('OpenAI error 429: Rate limit reached'))).toBe(true);
    expect(isRetryableProviderError(new Error('OpenAI error 500: server had an error'))).toBe(true);
    expect(isRetryableProviderError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableProviderError(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('gives up immediately on answers a retry cannot change', () => {
    expect(isRetryableProviderError(new Error('OpenAI error 401: Incorrect API key provided'))).toBe(false);
    expect(isRetryableProviderError(new Error('OpenAI error 404: The model `gpt-x` does not exist'))).toBe(false);
    // A quota exhaustion arrives as a 429 but is a billing state, not congestion.
    expect(isRetryableProviderError(new Error('OpenAI error 429: You exceeded your current quota (insufficient_quota)'))).toBe(false);
    // A caller-initiated abort means the work is no longer wanted.
    expect(isRetryableProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('withBackoff', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(noSleep);
    const result = await withBackoff(async () => 'ok', { sleep, random: fullJitter });
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops at the attempt cap and rethrows the last error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => { attempts.push(attempt); throw new Error('OpenAI error 429: Rate limit reached'); });

    await expect(withBackoff(fn, { attempts: 3, sleep: noSleep, random: fullJitter }))
      .rejects.toThrow(/429/);
    expect(attempts).toEqual([1, 2, 3]);   // exactly three, never a fourth
  });

  it('does not retry a non-retryable code', async () => {
    const fn = vi.fn(async () => { throw new Error('OpenAI error 401: Incorrect API key provided'); });
    await expect(withBackoff(fn, { attempts: 3, sleep: noSleep, random: fullJitter })).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially with full jitter, capped at maxDelayMs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const fn = async () => { throw new Error('OpenAI error 503: overloaded'); };

    await expect(withBackoff(fn, { attempts: 4, baseDelayMs: 400, maxDelayMs: 1000, sleep, random: fullJitter }))
      .rejects.toThrow(/503/);
    expect(delays).toEqual([400, 800, 1000]);   // 400, 800, then the cap
    // Jitter draws from [0, ceiling]; half the draw halves the wait.
    expect(backoffDelayMs(2, 400, 8000, () => 0.5)).toBe(400);
    expect(backoffDelayMs(1, 400, 8000, () => 0)).toBe(0);
  });

  it('never starts an attempt once the caller has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(withBackoff(fn, { signal: controller.signal, sleep: noSleep })).rejects.toBeInstanceOf(RetryAbortedError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts while sleeping between attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    const fn = vi.fn(async () => { throw new Error('OpenAI error 500: server had an error'); });
    // The real sleep implementation is exercised here: aborting mid-wait must
    // reject rather than run out the exponential delay.
    const pending = withBackoff(fn, { attempts: 3, baseDelayMs: 50_000, signal: controller.signal, random: fullJitter });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RetryAbortedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// The duplicate-write hazard the map flags under §29: a broken stream used to
// leave the caller with no text, and the caller's "no text ⇒ run it again"
// fallback re-executed every tool the stream had already run.
describe('runToolsStream never lets a broken stream re-run executed tools', () => {
  function sseResponse(chunks: string[], failAfter = Number.POSITIVE_INFINITY) {
    let i = 0;
    const enc = new TextEncoder();
    return Promise.resolve({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= failAfter) throw new Error('ECONNRESET: stream closed');
            return i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined };
          },
        }),
      },
    } as unknown as Response);
  }

  async function collect(gen: AsyncGenerator<StreamEvent>) {
    const events: StreamEvent[] = [];
    for await (const e of gen) events.push(e);
    return events;
  }

  const toolCallChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"add_note","arguments":"{}"}}]}}]}\n\n';

  it('closes the turn with a tool-free summary instead of throwing, once a tool has run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let executions = 0;
    const tools: ToolSpec[] = [{
      name: 'add_note', description: 'x', input_schema: { type: 'object' },
      execute: async () => { executions += 1; return { ok: true }; },
    }];

    const fetchMock = vi.fn()
      // Round 1: one tool call, streamed successfully.
      .mockReturnValueOnce(sseResponse([toolCallChunk, 'data: [DONE]\n\n']))
      // Round 2: the stream dies before any text arrives.
      .mockReturnValueOnce(sseResponse(['data: {"choices":[{"delta":{}}]}\n\n'], 0))
      // The recovery call is non-streaming and carries NO tools.
      .mockReturnValueOnce(Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: 'Saved your note.' } }] })),
        headers: { get: () => null },
      } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'note hi' }], tools }));

    expect(executions).toBe(1);                                   // the write happened exactly once
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Saved your note.');
    const recoveryBody = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(recoveryBody.tools).toBeUndefined();                   // nothing can re-execute
    expect(recoveryBody.stream).toBeUndefined();
  });

  it('falls back to fixed closing text when even the recovery call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools: ToolSpec[] = [{ name: 'add_note', description: 'x', input_schema: { type: 'object' }, execute: async () => ({ ok: true }) }];
    const fetchMock = vi.fn()
      .mockReturnValueOnce(sseResponse([toolCallChunk, 'data: [DONE]\n\n']))
      .mockReturnValueOnce(sseResponse([], 0))
      .mockReturnValueOnce(Promise.reject(new Error('fetch failed')));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'note hi' }], tools }));

    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    // Non-empty closing text is the invariant: it is what stops the caller's
    // "no text ⇒ re-run the tool loop" fallback from firing.
    expect(text).toBe(STREAM_INTERRUPTED_AFTER_ACTIONS);
    expect(text.length).toBeGreaterThan(0);
  });

  it('still throws when the stream breaks before any tool has run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockReturnValueOnce(sseResponse([], 0));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    // Nothing was written, so handing the caller the real error (and letting it
    // retry) is safe — and it must still see that error.
    await expect(collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })))
      .rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
