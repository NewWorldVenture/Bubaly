// lib/sync/feed-token.ts
//
// Public ICS feed slugs. A feed token is an unguessable, capability-style URL
// component: anyone holding it can read that one calendar's ICS, so it must be
// high-entropy and revocable (rotate the column to revoke). We also expose an
// HMAC verifier so a feed URL can optionally carry a signature for tamper-evidence.
//
// SERVER ONLY.

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

/** 32 bytes of entropy, URL-safe base64 (no padding). */
export function generateFeedToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Deterministic HMAC of a token, for optional signed feed URLs.
 *
 * Throws when `SYNC_TOKEN_KEY` is absent rather than signing with an empty
 * secret. This used to read `process.env.SYNC_TOKEN_KEY ?? ''`, which is the
 * shape `hasCronAuthorization` exists to avoid — a missing secret quietly
 * becoming a usable one. An HMAC keyed on '' is computable by anyone, so
 * `verifyFeedSignature` would have accepted a forged signature on any
 * deployment that had not set the variable, and said nothing.
 *
 * Every other use of this key already fails closed: `getKey()` in
 * lib/sync/crypto.ts throws, both sync callbacks say "fails closed without
 * SYNC_TOKEN_KEY", and architecture.md records it as fail-closed. This was the
 * one place that did not.
 *
 * Nothing calls these two functions today — that is precisely why the fallback
 * was worth removing rather than leaving for whoever wires them up first.
 */
export function signFeedToken(token: string): string {
  const secret = process.env.SYNC_TOKEN_KEY;
  if (!secret) {
    throw new Error('SYNC_TOKEN_KEY is not set; refusing to sign a feed token with an empty secret.');
  }
  return createHmac('sha256', secret).update(token).digest('base64url');
}

/**
 * Constant-time comparison of a presented signature against the expected one.
 *
 * Returns false — never throws — when the key is missing or the signature is
 * empty, so a caller using this as an authorization check fails closed on every
 * path rather than surfacing a 500 on one and admitting the request on another.
 */
export function verifyFeedSignature(token: string, signature: string): boolean {
  if (!signature || !process.env.SYNC_TOKEN_KEY) return false;
  const a = Buffer.from(signFeedToken(token));
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
