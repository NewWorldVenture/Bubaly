import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withCompleteRetry, type AIProvider } from '@/lib/ai/provider';

// BH-01. lib/ai/retry.ts is 141 lines of full-jitter, abort-aware backoff with
// an explicit non-retry list, and it had ONE consumer (lib/ai/structured.ts).
// The 47 `provider.complete(…)` sites had no retry anywhere in the chain, so a
// 429 — the commonest provider failure, clearing in milliseconds — reached the
// family as "The AI engine is busy right now (rate limit). Wait a few seconds
// and try again": the application asking a person to do by hand what the module
// was written to do.
//
// WHAT IS NOT RETRIED IS THE POINT OF THIS FILE. A retry around a method that
// executes tools would re-run the ones attempt one already ran, and §29 already
// records a double-write incident from a fallback of exactly that shape. So the
// exclusions are asserted behaviourally, one call at a time, rather than left to
// a comment in the delegate.

function rateLimited(): Error {
  return Object.assign(new Error('Rate limit reached'), { status: 429 });
}

/** Counts calls per method; `complete` fails `failTimes` times before succeeding. */
function spyProvider(failTimes = 0) {
  const calls = { complete: 0, structuredCompletion: 0, runTools: 0, runToolsStream: 0 };
  const inner = {
    id: 'openai',
    model: 'gpt-test',
    async complete() {
      calls.complete += 1;
      if (calls.complete <= failTimes) throw rateLimited();
      return { text: 'ok', toolCalls: [] };
    },
    async structuredCompletion() {
      calls.structuredCompletion += 1;
      throw rateLimited();
    },
    async runTools() {
      calls.runTools += 1;
      throw rateLimited();
    },
    async *runToolsStream() {
      calls.runToolsStream += 1;
      throw rateLimited();
    },
  } as unknown as AIProvider;
  return { inner, calls };
}

describe('the retry module now has the consumers its header names', () => {
  it('retries complete() past a 429 and returns the eventual success', async () => {
    const { inner, calls } = spyProvider(1);
    const result = await withCompleteRetry(inner).complete({ messages: [] } as never);
    expect(calls.complete).toBe(2);
    expect((result as { text: string }).text).toBe('ok');
  });

  it('does not retry a first-attempt success', async () => {
    const { inner, calls } = spyProvider(0);
    await withCompleteRetry(inner).complete({ messages: [] } as never);
    expect(calls.complete).toBe(1);
  });

  it('gives up rather than looping forever, and surfaces the provider error', async () => {
    const { inner, calls } = spyProvider(Number.MAX_SAFE_INTEGER);
    await expect(withCompleteRetry(inner).complete({ messages: [] } as never)).rejects.toThrow(/rate limit/i);
    // withBackoff's default is 3 attempts. Pinned so raising it is a decision:
    // OPENAI_TIMEOUT_MS is 60s and the AI routes declare maxDuration = 60, so a
    // first attempt that TIMES OUT has already spent the platform budget.
    expect(calls.complete).toBe(3);
  });

  it('does NOT retry structuredCompletion — it is already retried one layer up', async () => {
    // lib/ai/structured.ts:110 calls it inside withBackoff, itself inside a
    // two-pass repair loop. Wrapping here nests to 3 x 3 x 2 = eighteen paid
    // calls for one planner decision.
    const { inner, calls } = spyProvider();
    await expect(withCompleteRetry(inner).structuredCompletion({} as never)).rejects.toThrow();
    expect(calls.structuredCompletion).toBe(1);
  });

  it('does NOT retry runTools — a retryable failure may follow a tool that already ran', async () => {
    const { inner, calls } = spyProvider();
    await expect(withCompleteRetry(inner).runTools({} as never)).rejects.toThrow();
    expect(calls.runTools).toBe(1);
  });

  it('does NOT retry runToolsStream, whose §29 invariant a retry wrapper could break', async () => {
    const { inner, calls } = spyProvider();
    const it2 = withCompleteRetry(inner).runToolsStream({} as never);
    await expect(it2.next()).rejects.toThrow();
    expect(calls.runToolsStream).toBe(1);
  });

  it('passes id and model through, because every caller reads them', () => {
    const { inner } = spyProvider();
    const wrapped = withCompleteRetry(inner);
    expect(wrapped.id).toBe('openai');
    expect(wrapped.model).toBe('gpt-test');
  });
});

describe('every real provider is wrapped, and the stub is not', () => {
  // Source-level, because these are construction sites rather than behaviour.
  // Without this the delegate can be removed one site at a time and every
  // behavioural test above still passes.
  it('wraps all three OpenAIProvider construction sites', () => {
    for (const file of ['lib/ai/provider.ts', 'lib/ai/routing.ts']) {
      const src = readFileSync(file, 'utf8');
      const built = [...src.matchAll(/new OpenAIProvider\(/g)].length;
      const wrapped = [...src.matchAll(/withCompleteRetry\(\s*new OpenAIProvider\(/g)].length;
      expect(wrapped, `${file}: every OpenAIProvider must be wrapped`).toBe(built);
    }
  });

  it('leaves the scripted stub unwrapped, so CI asserts against the script', () => {
    // A retry loop around a scripted provider would re-run assertions, not a
    // network call.
    const src = readFileSync('lib/ai/routing.ts', 'utf8');
    expect(src).toContain('return scriptedProvider();');
    expect(src).not.toMatch(/withCompleteRetry\(\s*scriptedProvider\(\)/);
  });
});
