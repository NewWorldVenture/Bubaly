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
// IPv6 /64 — anything shaped like an email address, and an E.164 phone number
// (the Contact Center's per-sender budgets are keyed on the signed `From` of a
// text or a call, lib/contact-center/inbound-budget.ts). The digest is keyed
// on a server secret, so it cannot be reversed by hashing the IPv4 space, or
// the ten billion numbers of one country.
//
// ONLY while that secret is one. With neither INTERNAL_SECRET nor
// SUPABASE_SERVICE_ROLE_KEY set, the key used to fall back to the constant
// below — which is in this public repository, so every stored digest could be
// reversed by hashing the IPv4 space with it, and the table was the visitor log
// again. In production that configuration now FAILS CLOSED: a key that needs a
// digest throws, rateLimitDb answers "unavailable" (refused, unless the caller
// chose failOpen), and nothing is written. Development and tests, where no
// production secret exists, keep the constant so limiting still works there.
// A key with no IP or address in it (a signed-in caller's own id) needs no
// digest and is unaffected.
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const IPV6_64 = /(?<![0-9a-f])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3}::\/64/gi;
const EMAIL = /[^\s:@]+@[^\s:@]+/g;
const E164 = /(?<![\w+])\+[1-9]\d{6,14}(?!\d)/g;
const DEV_SUBJECT_KEY = 'bubaly-dev-rate-limit-subject';

function subjectKey(): string {
  const configured = [process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    console.error('[rate-limit] no INTERNAL_SECRET or SUPABASE_SERVICE_ROLE_KEY: refusing to store a bucket key under the public development key');
    throw new Error('The rate-limit subject key is not configured.');
  }
  return DEV_SUBJECT_KEY;
}

function digest(value: string): string {
  return `h.${createHmac('sha256', subjectKey()).update('rate-limit-subject\0').update(value).digest('hex').slice(0, 32)}`;
}

/**
 * The bucket key as stored: IP and email parts replaced by a keyed digest.
 * Throws in production when a part needs a digest and no secret is configured.
 */
export function storedBucketKey(key: string): string {
  return key
    .replace(EMAIL, (match) => digest(match.toLowerCase()))
    .replace(IPV6_64, (match) => digest(match.toLowerCase()))
    .replace(IPV4, (match) => digest(match))
    .replace(E164, (match) => digest(match));
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
  const hit = await rateLimitDbVerdict(supabase, key, { limit, windowMs });
  if (hit.verdict === 'unavailable') return { ok: failOpen, retryAfter: failOpen ? 0 : 5 };
  return hit.verdict === 'allowed' ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: hit.retryAfter };
}

/** One durable hit, with "could not be evaluated" kept apart from "refused". */
export type RateLimitDbVerdict =
  | { verdict: 'allowed' }
  | { verdict: 'refused'; retryAfter: number }
  | { verdict: 'unavailable' };

/**
 * The hit `rateLimitDb` makes, answered without folding an unavailable limiter
 * into a refusal (or, with failOpen, an allowance) — which is right for a
 * budget, and wrong for a caller that uses a limit of one as an ARBITER: the
 * first hit on a key wins and every later one is a repeat. Such a caller has to
 * answer a repeat and an outage differently (app/reviews/new/actions.ts), so it
 * needs to know which one it got.
 */
export async function rateLimitDbVerdict(
  supabase: SupabaseClient<Database>,
  key: string,
  { limit = 10, windowMs = 60_000 }: Pick<RateLimitDbOptions, 'limit' | 'windowMs'> = {},
): Promise<RateLimitDbVerdict> {
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
    if (error || !data || (Array.isArray(data) && data.length !== 1)) return { verdict: 'unavailable' };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== 'boolean') return { verdict: 'unavailable' };
    if (row.allowed) return { verdict: 'allowed' };
    const parsedRetryAfter = Number(row.retry_after);
    const retryAfter = Number.isFinite(parsedRetryAfter)
      ? Math.max(0, Math.ceil(parsedRetryAfter))
      : 0;
    return { verdict: 'refused', retryAfter: Math.max(1, retryAfter) };
  } catch {
    return { verdict: 'unavailable' };
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
