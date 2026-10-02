import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { rateLimitDb } from '@/lib/server/rate-limit-db';

function client(result: unknown) {
  return { rpc: vi.fn().mockResolvedValue(result) } as never;
}

describe('durable rate-limit boundary', () => {
  it('accepts a valid allowed RPC result', async () => {
    const supabase = client({ data: [{ allowed: true, retry_after: 0 }], error: null });

    await expect(rateLimitDb(supabase, 'test:key', { limit: 3, windowMs: 2_500 })).resolves.toEqual({
      ok: true,
      retryAfter: 0,
    });
    expect((supabase as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith('rate_limit_hit', {
      p_key: 'test:key',
      p_limit: 3,
      p_window_seconds: 3,
    });
  });

  it('preserves a valid denial and never returns a zero retry window', async () => {
    const supabase = client({ data: [{ allowed: false, retry_after: 0 }], error: null });

    await expect(rateLimitDb(supabase, 'test:key')).resolves.toEqual({ ok: false, retryAfter: 1 });
  });

  it('fails closed for RPC errors, empty data, malformed rows, and thrown calls', async () => {
    await expect(rateLimitDb(client({ data: null, error: new Error('db down') }), 'error:key'))
      .resolves.toEqual({ ok: false, retryAfter: 5 });
    await expect(rateLimitDb(client({ data: [], error: null }), 'empty:key'))
      .resolves.toEqual({ ok: false, retryAfter: 5 });
    await expect(rateLimitDb(client({ data: [{ allowed: 'yes' }], error: null }), 'shape:key'))
      .resolves.toEqual({ ok: false, retryAfter: 5 });
    const throwing = { rpc: vi.fn().mockRejectedValue(new Error('network down')) } as never;
    await expect(rateLimitDb(throwing, 'throw:key')).resolves.toEqual({ ok: false, retryAfter: 5 });
  });

  it('supports an explicit availability-first override', async () => {
    await expect(rateLimitDb(client({ data: null, error: new Error('db down') }), 'legacy:key', { failOpen: true }))
      .resolves.toEqual({ ok: true, retryAfter: 0 });
  });
});

// Exercise the actual SDK with an inert RPC transport; no database or caller workflow.
type RpcResponseCase = {
  name: string;
  body: unknown;
  expected: { ok: boolean; retryAfter: number };
  status?: number;
  transportError?: boolean;
  failOpen?: boolean;
};
const responseCases: RpcResponseCase[] = [
  { name: 'object allowed result', body: { allowed: true, retry_after: 0 }, expected: { ok: true, retryAfter: 0 } },
  { name: 'one-row allowed array', body: [{ allowed: true, retry_after: 0 }], expected: { ok: true, retryAfter: 0 } },
  { name: 'one-row denied array', body: [{ allowed: false, retry_after: 0 }], expected: { ok: false, retryAfter: 1 } },
  { name: 'malformed boolean', body: [{ allowed: 'true', retry_after: 0 }], expected: { ok: false, retryAfter: 5 } },
  { name: 'empty array', body: [], expected: { ok: false, retryAfter: 5 } },
  { name: 'null result', body: null, expected: { ok: false, retryAfter: 5 } },
  { name: 'reported RPC error', status: 503, body: { code: 'XX000', message: 'Synthetic RPC refusal' }, expected: { ok: false, retryAfter: 5 } },
  { name: 'transport refusal', transportError: true, body: null, expected: { ok: false, retryAfter: 5 } },
  { name: 'explicit failOpen remains availability-first', status: 503, body: { code: 'XX000', message: 'Synthetic RPC refusal' }, failOpen: true, expected: { ok: true, retryAfter: 0 } },
  { name: 'multiple conflicting rows refuse ambiguous admission', body: [{ allowed: true, retry_after: 0 }, { allowed: false, retry_after: 60 }], expected: { ok: false, retryAfter: 5 } },
  { name: 'duplicate allowed rows still refuse ambiguous cardinality', body: [{ allowed: true, retry_after: 0 }, { allowed: true, retry_after: 0 }], expected: { ok: false, retryAfter: 5 } },
];

describe('durable rate-limit SDK response boundary', () => {
  for (const scenario of responseCases) {
    it(scenario.name, async () => {
      const requests: { path: string; method: string | undefined; body: unknown }[] = [];
      const transport: typeof fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://rpc-fixture.invalid');
        expect(url.pathname).toBe('/rest/v1/rpc/rate_limit_hit');
        expect(init.method).toBe('POST');
        requests.push({ path: url.pathname, method: init.method, body: JSON.parse(String(init.body)) });
        if (scenario.transportError) throw new TypeError('Synthetic transport refusal');
        return new Response(JSON.stringify(scenario.body), {
          status: scenario.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const db = createClient('https://rpc-fixture.invalid', 'synthetic-public-key', {
        global: { fetch: transport },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const result = await rateLimitDb(db as never, 'synthetic:ordinary', {
        limit: 3, windowMs: 2500, failOpen: scenario.failOpen ?? false,
      });
      expect(requests).toEqual([{
        path: '/rest/v1/rpc/rate_limit_hit', method: 'POST',
        body: { p_key: 'synthetic:ordinary', p_limit: 3, p_window_seconds: 3 },
      }]);
      expect(result).toEqual(scenario.expected);
    });
  }
});
