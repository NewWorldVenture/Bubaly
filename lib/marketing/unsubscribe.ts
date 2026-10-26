import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { configuredSecret } from '@/lib/server/configured-secret';

// Signed unsubscribe tokens so the public unsubscribe link can't be forged or
// enumerated. Token = HMAC-SHA256(email) using a server secret.
//
// The signing secret is the first of MARKETING_UNSUB_SECRET and INTERNAL_SECRET
// that is set, else SUPABASE_SERVICE_ROLE_KEY. A blank or whitespace-only value
// counts as unset, as /api/health's checkFeatureEnv treats it.
//
// A token is verified against both of the first two when both are set, not
// only the first. A link mailed while the dedicated secret was unset was
// signed with INTERNAL_SECRET, and it has to keep working after an operator
// sets MARKETING_UNSUB_SECRET (ENV-F3AB1A14762D): otherwise setting the secret
// would break every unsubscribe link already in someone's inbox, which is a
// compliance failure dressed up as a rotation. Signing always uses the first,
// so new links move to the dedicated secret as soon as it exists.
//
// The service-role key is different: it signs only while neither of the other
// two is set, and it verifies only then. A database credential must not stay a
// valid unsubscribe key for ever once a real signing secret exists.
const DEV_SECRET = 'bubaly-dev-unsub-secret';

// A value copied from .env.example is not set: it would sign links anyone can forge.
const isSet = (value: string | undefined): value is string => configuredSecret(value) !== null;

/** The secrets a mailed link may have been signed with, in signing order. */
function signingSecrets(): string[] {
  const dedicated = [process.env.MARKETING_UNSUB_SECRET, process.env.INTERNAL_SECRET].filter(isSet);
  if (dedicated.length > 0) return dedicated;
  return [process.env.SUPABASE_SERVICE_ROLE_KEY].filter(isSet);
}

function secret(): string {
  const [first] = signingSecrets();
  if (first) return first;
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
  const configured = signingSecrets();
  // Nothing configured: the dev secret outside production, a thrown error in it
  // (the route answers 503), exactly as signing does.
  const keys = configured.length > 0 ? configured : [secret()];
  const provided = Buffer.from(token);
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(sign(email, key));
    // Every candidate is checked, each in constant time, so the answer does
    // not say which one matched.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true;
  }
  return matched;
}

export function unsubUrl(appUrl: string, email: string): string {
  const e = encodeURIComponent(email.trim().toLowerCase());
  return `${appUrl.replace(/\/$/, '')}/api/marketing/unsubscribe?e=${e}&t=${unsubToken(email)}`;
}
