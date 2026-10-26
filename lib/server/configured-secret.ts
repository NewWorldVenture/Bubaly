// lib/server/configured-secret.ts — a secret that was never replaced is no secret.
//
// `.env.example` ships non-empty example values for several secrets that
// authenticate callers (webhook signing secrets, the internal and Guardian
// call secrets, the child-login secret). Every read site already refuses an
// UNSET secret. A deployment that copied the file unchanged, though, held a
// value anyone can read in this repository, and every one of those checks
// passed it: a forged Stripe or Resend event verified, an internal call signed
// with `generate_a_random_string` was let in (SEC-002).
//
// So a published example value is answered exactly as an unset one: null.
// `tests/a-secret-copied-from-env-example-is-not-a-secret.test.ts` fails if
// `.env.example` gains a non-empty secret this list does not name.
//
// No dependencies, so the health check can import it as well as the request
// paths.

/** The example values `.env.example` ships for secrets. Never valid secrets. */
export const PUBLISHED_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'generate_a_random_string',
  'whsec_your_webhook_signing_secret',
  'whsec_your_resend_webhook_secret',
  'your-service-role-secret-key',
  'sk_live_or_test_your_secret_key',
  'your-google-oauth-client-secret',
]);

/** True when a value is a published example, not a secret anyone chose. */
export function isPublishedPlaceholder(value: string | null | undefined): boolean {
  return typeof value === 'string' && PUBLISHED_SECRET_PLACEHOLDERS.has(value.trim());
}

/**
 * The secret to check against, or null when there is none: unset, blank, or a
 * value copied from `.env.example`. Every caller already treats null as
 * "disabled", never "open".
 */
export function configuredSecret(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (isPublishedPlaceholder(value)) return null;
  return value;
}
