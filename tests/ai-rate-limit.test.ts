import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

function client(allowed: boolean): { client: SupabaseClient<Database>; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockResolvedValue({
    data: [{ allowed, retry_after: allowed ? 0 : 17 }],
    error: null,
  });
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

describe('paid AI request limits', () => {
  it('allows a request when both local and durable guards allow it', async () => {
    const { client: supabase, rpc } = client(true);
    const result = await enforceAIRateLimit(supabase, `ai-rate-test-${crypto.randomUUID()}`, { limit: 2 });
    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('returns the durable retry window when the shared guard rejects', async () => {
    const { client: supabase } = client(false);
    const result = await enforceAIRateLimit(supabase, `ai-rate-test-${crypto.randomUUID()}`, { limit: 2 });
    expect(result).toEqual({ ok: false, retryAfter: 17 });
  });

  it('stops locally before making another durable call after the local limit', async () => {
    const { client: supabase, rpc } = client(true);
    const key = `ai-rate-test-${crypto.randomUUID()}`;
    expect(await enforceAIRateLimit(supabase, key, { limit: 1 })).toEqual({ ok: true });
    expect(await enforceAIRateLimit(supabase, key, { limit: 1 })).toMatchObject({ ok: false });
    expect(rpc).toHaveBeenCalledOnce();
  });
});
