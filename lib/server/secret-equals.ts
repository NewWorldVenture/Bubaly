import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// One comparison for every shared secret this server checks.
//
// `===` on strings short-circuits at the first differing byte, so how long it
// takes to fail is a function of how much of the secret the caller guessed
// right. Four places compared a secret that way — the cron header, the internal
// header, the Guardian escalation bearer and the contact-center inbound token —
// while `lib/guardian/twilio.ts:143` three files away already reached for
// `timingSafeEqual` on the Twilio signature.
//
// Extracting a secret this way over HTTP against a serverless platform is not a
// practical attack, and that is worth saying plainly rather than dressing this
// up. It is here because the codebase already owns the right primitive and four
// call sites did not use it, which is the same shape as every other finding in
// this sweep: the rule is written down somewhere and not applied where it
// counts. These four gate every scheduled job, every internal callback, the
// emergency escalation fan-out and inbound email.
//
// HMAC rather than comparing the raw bytes, because `timingSafeEqual` THROWS on
// a length mismatch — so a raw comparison needs a length check first, and that
// check leaks the length in exactly the way the function is meant to avoid.
// Digests are always 32 bytes. The key is random per process and never leaves
// it, so the digests say nothing about the secret.
const FINGERPRINT_KEY = randomBytes(32);

const fingerprint = (value: string): Buffer =>
  createHmac('sha256', FINGERPRINT_KEY).update(value, 'utf8').digest();

/**
 * True when `provided` is exactly `expected`, compared in constant time.
 *
 * Fail-closed on a missing value on either side, which is the more important
 * property of the four call sites and was already correct at all of them: an
 * unset secret must never turn a missing header into a match, nor
 * `"Bearer undefined"` into a valid credential.
 */
export function secretEquals(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(fingerprint(provided), fingerprint(expected));
}
