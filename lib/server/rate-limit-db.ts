// Durable, cross-instance rate limiting backed by the Postgres rate_limit_hit RPC.
// Fail closed by default so a database outage cannot silently remove abuse controls.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type RateLimitDbOptions = {
  limit?: number;
  windowMs?: number;
  /** Allow the request when the durable limiter cannot be evaluated. */
  failOpen?: boolean;
};

export async function rateLimitDb(
  supabase: SupabaseClient<Database>,
  key: string,
  { limit = 10, windowMs = 60_000, failOpen = false }: RateLimitDbOptions = {},
): Promise<{ ok: boolean; retryAfter: number }> {
  const unavailable = (): { ok: boolean; retryAfter: number } => ({
    ok: failOpen,
    retryAfter: failOpen ? 0 : 5,
  });

  try {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 10;
    const safeWindowSeconds = Number.isFinite(windowMs)
      ? Math.max(1, Math.ceil(windowMs / 1000))
      : 60;
    const { data, error } = await supabase.rpc('rate_limit_hit', {
      p_key: key,
      p_limit: safeLimit,
      p_window_seconds: safeWindowSeconds,
    });
    if (error || !data) return unavailable();
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== 'boolean') return unavailable();
    const parsedRetryAfter = Number(row.retry_after);
    const retryAfter = Number.isFinite(parsedRetryAfter)
      ? Math.max(0, Math.ceil(parsedRetryAfter))
      : 0;
    return { ok: row.allowed, retryAfter: row.allowed ? 0 : Math.max(1, retryAfter) };
  } catch {
    return unavailable();
  }
}
