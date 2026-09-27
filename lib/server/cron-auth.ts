/**
 * Fail-closed authorization for scheduled and internal server callbacks.
 * Missing secrets must never turn into a valid literal such as "Bearer undefined".
 *
 * Compared in constant time (F-E08): `===` on a shared secret returns in a
 * number of steps proportional to the matching prefix, which is a way to learn
 * one character at a time. `bearerMatches`/`secretsMatch` keep the fail-closed
 * behaviour — an unset secret is never a match — and drop the timing signal.
 */
import { bearerMatches, secretsMatch } from '@/lib/server/secret-compare';

export function hasCronAuthorization(req: Request, secret = process.env.CRON_SECRET): boolean {
  return bearerMatches(req.headers.get('authorization'), secret);
}

export function hasInternalSecret(req: Request, secret = process.env.INTERNAL_SECRET): boolean {
  return secretsMatch(req.headers.get('x-internal-secret'), secret);
}
