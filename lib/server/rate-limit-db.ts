// lib/server/rate-limit-db.ts — durable, cross-instance rate limiting (AI-2).
//
// The in-memory limiter (lib/server/rate-limit.ts) counts per serverless INSTANCE,
// so it's weak under horizontal scale. This calls the Postgres `rate_limit_hit`
// RPC (migration 0156) for a shared fixed-window counter every instance agrees on.
// FAIL-OPEN: if the table/RPC isn't applied yet or the DB errors, it allows the
// request (the in-memory limiter still provides per-instance protection) — a
// rate limiter must never take an endpoint down.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export async function rateLimitDb(
  supabase: SupabaseClient<Database>,
  key: string,
  { limit = 10, windowMs = 60_000 }: { limit?: number; windowMs?: number } = {},
): Promise<{ ok: boolean; retryAfter: number }> {
  try {
    const { data, error } = await supabase.rpc('rate_limit_hit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
    });
    if (error || !data) return { ok: true, retryAfter: 0 }; // fail-open
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: row?.allowed !== false, retryAfter: Number(row?.retry_after ?? 0) };
  } catch {
    return { ok: true, retryAfter: 0 };
  }
}
