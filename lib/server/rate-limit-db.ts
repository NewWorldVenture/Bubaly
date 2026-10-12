// Durable, cross-instance rate limiting backed by the Postgres rate_limit_hit RPC.
// Fail closed by default so a database outage cannot silently remove abuse controls.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// WHAT THE TABLE KEEPS. Every public route keys its limit on the caller's IP
// (`contact:<ip>`, `form:<ip>`, `mkt:<ip>` …) and /api/blog/subscribe on an
// address somebody typed (`blogsub:addr:<email>`). Passed verbatim, those
// became rows in public.rate_limits — a per-window log of which IP used which
// public endpoint, and which addresses were submitted, kept for as long as the
// table was. The limiter needs only EQUALITY between two hits of one subject, so
// the IP and address parts are replaced by a keyed digest before they reach the
// database. Everything else in the key is kept as written: the namespace, for
// whoever reads the table, and a signed-in caller's own id, which rate_limit_hit
// (0179) requires to appear in their key.
//
// The forms replaced are the ones `clientIp` produces — an IPv4 address or an
// IPv6 /64 — and anything shaped like an email address. The digest is keyed on
// a server secret, so it cannot be reversed by hashing the IPv4 space.
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const IPV6_64 = /(?<![0-9a-f])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3}::\/64/gi;
const EMAIL = /[^\s:@]+@[^\s:@]+/g;

function subjectKey(): string {
  const configured = [process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  return configured ?? 'bubaly-dev-rate-limit-subject';
}

function digest(value: string): string {
  return `h.${createHmac('sha256', subjectKey()).update('rate-limit-subject\0').update(value).digest('hex').slice(0, 32)}`;
}

/** The bucket key as stored: IP and email parts replaced by a keyed digest. */
export function storedBucketKey(key: string): string {
  return key
    .replace(EMAIL, (match) => digest(match.toLowerCase()))
    .replace(IPV6_64, (match) => digest(match.toLowerCase()))
    .replace(IPV4, (match) => digest(match));
}

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
      p_key: storedBucketKey(key),
      p_limit: safeLimit,
      p_window_seconds: safeWindowSeconds,
    });
    if (error || !data || (Array.isArray(data) && data.length !== 1)) return unavailable();
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

/**
 * Delete limiter windows older than a day (`rate_limit_prune`, 0156).
 *
 * Nothing called it, so every bucket ever written stayed in the table for good.
 * The horizon stays at the function's one day rather than the longest public
 * window (an hour): the import claim in app/(app)/dashboard/migrate/actions.ts
 * holds an 86,400-second window, and pruning under it would hand the claim out
 * twice. True when the database confirmed the prune.
 */
export async function pruneRateLimits(supabase: SupabaseClient<Database>): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('rate_limit_prune');
    return !error;
  } catch {
    return false;
  }
}
