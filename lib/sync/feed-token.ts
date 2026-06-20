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

/** Deterministic HMAC of a token, for optional signed feed URLs. */
export function signFeedToken(token: string): string {
  const secret = process.env.SYNC_TOKEN_KEY ?? '';
  return createHmac('sha256', secret).update(token).digest('base64url');
}

/** Constant-time comparison of a presented signature against the expected one. */
export function verifyFeedSignature(token: string, signature: string): boolean {
  const expected = signFeedToken(token);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
