/**
 * Fail-closed authorization for scheduled and internal server callbacks.
 * Missing secrets must never turn into a valid literal such as "Bearer undefined".
 */
export function hasCronAuthorization(req: Request, secret = process.env.CRON_SECRET): boolean {
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`;
}

export function hasInternalSecret(req: Request, secret = process.env.INTERNAL_SECRET): boolean {
  return !!secret && req.headers.get('x-internal-secret') === secret;
}
