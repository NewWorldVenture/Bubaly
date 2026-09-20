// lib/server/secret-compare.ts — comparing a presented secret to the real one.
//
// `provided === expected` on a shared secret decides in a number of steps
// proportional to how many leading characters match, so a caller who can time
// the answer can learn the secret one character at a time. These are the
// endpoints that authorize a cron run, an internal server-to-server call, an
// emergency SMS/voice blast to every parent, and an inbound-email ingress, so
// the comparison is worth doing properly (F-E08).
//
// What this deliberately does NOT hide is the LENGTH: `timingSafeEqual` throws
// on unequal lengths, so a length check has to come first. That is the same
// shape lib/sync/feed-token.ts and the Resend webhook already use, and the
// length of a secret is not the secret.
import { timingSafeEqual } from 'node:crypto';

/**
 * True only when both values are present and identical.
 *
 * An absent expectation is never a match: an unset secret must mean "this is
 * disabled", never "everything matches". That is the property every caller
 * here depends on, and the reason this returns false rather than throwing.
 */
export function secretsMatch(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>`, compared in constant time. */
export function bearerMatches(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret) return false;
  return secretsMatch(header, `Bearer ${secret}`);
}
