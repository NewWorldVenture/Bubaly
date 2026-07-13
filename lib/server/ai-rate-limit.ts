import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { rateLimit } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';

type AIRateLimitOptions = { limit: number; windowMs?: number };

/** Apply the local guard and the shared Postgres guard before paid AI work. */
export async function enforceAIRateLimit(
  supabase: SupabaseClient<Database>,
  key: string,
  { limit, windowMs = 60_000 }: AIRateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const local = rateLimit(key, { limit, windowMs });
  if (!local.ok) return { ok: false, retryAfter: local.retryAfter };

  const durable = await rateLimitDb(supabase, key, { limit, windowMs });
  if (!durable.ok) return { ok: false, retryAfter: durable.retryAfter };
  return { ok: true };
}
