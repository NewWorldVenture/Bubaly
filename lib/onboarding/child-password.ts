import { createHash } from 'node:crypto';

// Server-only: derives a child's auth-user password from their PIN. Kept in its
// own module (not lib/onboarding/child-login.ts) because that file's pure string
// helpers are also imported by client components, and `node:crypto` cannot be
// bundled for the browser. Only server actions import this.

/**
 * Deterministically derive the child's auth password from their PIN. A server
 * secret is mixed in so the 4-digit PIN can't be brute-forced offline. The same
 * (secret, username, pin) always yields the same 64-char hex password, so
 * sign-in works and a PIN reset just re-derives it.
 */
export function deriveChildPassword(secret: string, username: string, pin: string): string {
  return createHash('sha256').update(`${secret}::${username}::${pin}`).digest('hex');
}
