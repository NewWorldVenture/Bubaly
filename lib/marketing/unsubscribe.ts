import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed unsubscribe tokens so the public unsubscribe link can't be forged or
// enumerated. Token = HMAC-SHA256(email) using a server secret.
//
// The signing secret is the first of MARKETING_UNSUB_SECRET, INTERNAL_SECRET
// and SUPABASE_SERVICE_ROLE_KEY that is set. A token is verified against EVERY
// one of them that is set, not only the first. A link mailed while the
// dedicated secret was unset was signed with the fallback, and it has to keep
// working after an operator sets MARKETING_UNSUB_SECRET (ENV-F3AB1A14762D):
// otherwise setting the secret would break every unsubscribe link already in
// someone's inbox, which is a compliance failure dressed up as a rotation.
// Signing always uses the first secret, so new links move to the dedicated
// one as soon as it exists.
const DEV_SECRET = 'bubaly-dev-unsub-secret';

function configuredSecrets(): string[] {
  return [process.env.MARKETING_UNSUB_SECRET, process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function secret(): string {
  const [configured] = configuredSecrets();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MARKETING_UNSUB_SECRET is not configured');
  }
  return DEV_SECRET;
}

function sign(email: string, key: string): string {
  return createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}

export function unsubToken(email: string): string {
  return sign(email, secret());
}

export function verifyUnsubToken(email: string, token: string): boolean {
  if (!token) return false;
  const configured = configuredSecrets();
  // Nothing configured: the dev secret outside production, a thrown error in it
  // (the route answers 503), exactly as signing does.
  const keys = configured.length > 0 ? configured : [secret()];
  const provided = Buffer.from(token);
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(sign(email, key));
    // Every configured secret is checked, each in constant time, so the answer
    // does not say which one matched.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true;
  }
  return matched;
}

export function unsubUrl(appUrl: string, email: string): string {
  const e = encodeURIComponent(email.trim().toLowerCase());
  return `${appUrl.replace(/\/$/, '')}/api/marketing/unsubscribe?e=${e}&t=${unsubToken(email)}`;
}
