import { isIP } from 'node:net';

// Lightweight in-memory rate limiter (fixed window) for API routes.
// Good for a single instance / dev; swap for Upstash Redis in multi-instance prod.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
const MAX_KEY_LENGTH = 256;

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(
  key: string,
  { limit = 10, windowMs = 60_000 }: { limit?: number; windowMs?: number } = {},
): { ok: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  const safeKey = typeof key === 'string' ? key.slice(0, MAX_KEY_LENGTH) : 'unknown';
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 10;
  const safeWindowMs = Number.isFinite(windowMs) ? Math.max(1_000, Math.ceil(windowMs)) : 60_000;
  const existing = buckets.get(safeKey);
  if (!existing || existing.resetAt <= now) {
    if (existing) buckets.delete(safeKey);
    pruneBuckets(now);
    if (buckets.size >= MAX_BUCKETS) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    buckets.set(safeKey, { count: 1, resetAt: now + safeWindowMs });
    return { ok: true, remaining: safeLimit - 1, retryAfter: 0 };
  }
  existing.count += 1;
  if (existing.count > safeLimit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: safeLimit - existing.count, retryAfter: 0 };
}

/** Best-effort client IP from proxy headers, normalized before key construction. */
export function clientIp(headers: Headers): string {
  const candidates = [
    headers.get('x-forwarded-for')?.split(',')[0],
    headers.get('x-real-ip'),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && value.length <= 64 && isIP(value)) return value;
  }
  return 'unknown';
}
