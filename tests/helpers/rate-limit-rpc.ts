import type { InMemorySupabase } from './in-memory-supabase';

/**
 * `rate_limit_hit` (0156/0179) over the fake's `rate_limits` table: fixed
 * windows, every hit counted, `allowed` while the count is within the limit —
 * what the Postgres function does, so a route driven against
 * `createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } })` meets a
 * limiter that counts rather than one that is "unavailable" (the fake answers an
 * unknown function with an error, and `rateLimitDb` fails closed on that).
 */
export function rateLimitHit(args: Record<string, unknown>, db: InMemorySupabase): { allowed: boolean; retry_after: number }[] {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = db.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}
