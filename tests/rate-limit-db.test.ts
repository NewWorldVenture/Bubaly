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
