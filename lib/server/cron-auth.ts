import { secretEquals } from '@/lib/server/secret-equals';

/**
 * Fail-closed authorization for scheduled and internal server callbacks.
 * Missing secrets must never turn into a valid literal such as "Bearer undefined".
 *
 * `secretEquals` rather than `===`: see lib/server/secret-equals.ts. The
 * fail-closed behaviour is unchanged — it is the property that matters here and
 * it was already right — and `secretEquals` fails closed on a missing value on
 * either side, so the `!!secret` guard is now belt-and-braces rather than the
 * only thing standing between an unset secret and "Bearer undefined".
 */
export function hasCronAuthorization(req: Request, secret = process.env.CRON_SECRET): boolean {
  return !!secret && secretEquals(req.headers.get('authorization'), `Bearer ${secret}`);
}

export function hasInternalSecret(req: Request, secret = process.env.INTERNAL_SECRET): boolean {
  return !!secret && secretEquals(req.headers.get('x-internal-secret'), secret);
}
