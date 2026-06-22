// lib/billing/checkout-abandonment.ts — pure selection logic for abandoned
// checkout sweeps. A checkout is "abandoned" when it was created but never
// completed within a grace window. We also cap how old we'll look back so we
// never email someone about a checkout from days ago (Stripe sessions expire
// after ~24h anyway). Kept pure + unit-testable; the cron does the DB + sends.

export type CheckoutSessionLike = {
  session_id: string;
  email: string | null;
  name: string | null;
  status: string;
  created_at: string;
};

export type AbandonmentOptions = {
  /** Minutes a pending checkout must sit before it counts as abandoned. */
  graceMinutes?: number;
  /** Don't look back further than this many hours (avoid stale sends). */
  maxAgeHours?: number;
};

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * Selects pending checkouts that are abandoned right now: status 'pending',
 * older than the grace window, newer than the max look-back, and with an email
 * to send to. Deterministic given `now`.
 */
export function selectAbandonedSessions(
  sessions: CheckoutSessionLike[],
  now: number = Date.now(),
  opts: AbandonmentOptions = {},
): CheckoutSessionLike[] {
  const grace = (opts.graceMinutes ?? 60) * MIN;
  const maxAge = (opts.maxAgeHours ?? 24) * HOUR;
  return sessions.filter((s) => {
    if (s.status !== 'pending') return false;
    if (!s.email) return false;
    const created = new Date(s.created_at).getTime();
    if (Number.isNaN(created)) return false;
    const age = now - created;
    return age >= grace && age <= maxAge;
  });
}
