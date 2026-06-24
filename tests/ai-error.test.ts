import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider, describeAIError } from '@/lib/ai/provider';

afterEach(() => vi.restoreAllMocks());

function errResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
}

describe('describeAIError classification', () => {
  it('maps a missing key to an unconfigured message', () => {
    const r = describeAIError(new Error('OpenAI API key is not configured'));
    expect(r.code).toBe('unconfigured');
    expect(r.message).toMatch(/set up|api key/i);
  });

  it('maps quota errors to an out-of-credits message', () => {
    const r = describeAIError(new Error('OpenAI error 429: You exceeded your current quota (insufficient_quota)'));
    // quota wins over the 429 rate-limit branch
    expect(r.code).toBe('quota');
    expect(r.message).toMatch(/credits|billing/i);
  });

  it('maps a 401 to an invalid-key message', () => {
    const r = describeAIError(new Error('OpenAI error 401: Incorrect API key provided'));
    expect(r.code).toBe('auth');
  });

  it('maps a plain 429 to a rate-limit message', () => {
    const r = describeAIError(new Error('OpenAI error 429: Rate limit reached'));
    expect(r.code).toBe('rate_limit');
  });

  it('maps a 404 / unknown model to a model message', () => {
    const r = describeAIError(new Error('OpenAI error 404: The model `gpt-x` does not exist'));
    expect(r.code).toBe('model');
  });

  it('maps network failures', () => {
    const r = describeAIError(new Error('fetch failed: ETIMEDOUT'));
    expect(r.code).toBe('network');
  });

  it('falls back to a generic message and redacts bearer tokens', () => {
    const r = describeAIError(new Error('weird failure with Authorization: Bearer sk-secret123 leaked'));
    expect(r.code).toBe('unknown');
    expect(r.detail).not.toContain('sk-secret123');
    expect(r.detail).toContain('Bearer …');
  });
});

describe('OpenAIProvider surfaces concise, classifiable errors', () => {
  it('throws an error carrying the status + parsed message on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(errResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } })));
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    await expect(provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }))
      .rejects.toThrow(/429.*quota/i);
  });

  it('classifies that thrown error as quota end-to-end', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(errResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } })));
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    try {
      await provider.runTools({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(describeAIError(err).code).toBe('quota');
    }
  });
});
