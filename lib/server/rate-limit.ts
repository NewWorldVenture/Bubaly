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

/** The eight 16-bit groups of an address `isIP` has already accepted as IPv6. */
function ipv6Groups(address: string): number[] {
  // A zone index would hide a trailing dotted quad from the match below.
  let text = address.split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = tail === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return groups.map(group => parseInt(group, 16));
}

/**
 * The subject a per-client limit counts: an IPv4 address, or an IPv6 /64.
 *
 * Keyed on the address as written, an IPv6 client was a new subject with every
 * address it chose, and a single subscriber is routinely handed a whole /64 —
 * 2^64 of them. Measured through `rateLimit` at a limit of 5: fifty hosts in one
 * /64 were fifty subjects and all fifty were allowed; one address in four
 * spellings was four subjects; an IPv4 client and its IPv4-mapped form were two.
 * A /64 is the smallest block a network assigns to one site, so it is the unit
 * that one client can be held to.
 */
function limitSubject(address: string): string {
  if (isIP(address) === 4) return address;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}

/**
 * Best-effort client identity from proxy headers, for rate-limit keys only: an
 * IPv4 address, or the /64 an IPv6 address belongs to (see `limitSubject`).
 */
export function clientIp(headers: Headers): string {
  const candidates = [
    headers.get('x-forwarded-for')?.split(',')[0],
    headers.get('x-real-ip'),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && value.length <= 64 && isIP(value)) return limitSubject(value);
  }
  return 'unknown';
}
