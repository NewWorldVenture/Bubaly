// Pure detection of a NEW paid conversion, for the founder's admin alert.
// Tested (tests/billing-conversion.test.ts) — no Stripe, no Supabase.

type SubState = { plan?: string | null; status?: string | null } | null | undefined;

/** True when a subscription is a paid plan in the `active` state. */
export function isPaidActive(s: { plan?: string | null; status?: string | null }): boolean {
  return !!s.plan && s.plan !== 'free' && s.status === 'active';
}

/**
 * True when a subscription just crossed into paid+active from something that
 * wasn't (no prior row, free, trialing, past_due, canceled…). Fires once on the
 * conversion — NOT on renewals (which stay paid+active), so the founder gets one
 * "🎉 new paid family" alert, not a ping every billing cycle.
 */
export function isNewPaidConversion(prev: SubState, next: { plan: string; status: string }): boolean {
  if (!isPaidActive(next)) return false;
  if (!prev) return true;                         // no prior state → brand-new paid sub
  return !isPaidActive({ plan: prev.plan, status: prev.status }); // was not paid+active before
}

// Terminal "the subscription is lost" states (as opposed to `past_due`, which is
// dunning that may still recover, so it must NOT count as churn).
const LOST_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/**
 * True when a PAYING family just churned: was paid+active, and is now either on
 * the free plan (downgrade) or in a terminal lost status (canceled/unpaid/
 * expired). Fires once on the loss — NOT on a tier change that stays paid+active
 * (plus↔basic), and NOT on transient `past_due`. Mirror of isNewPaidConversion
 * so the founder sees losses as clearly as wins.
 */
export function isChurn(prev: SubState, next: { plan: string; status: string }): boolean {
  if (!prev || !isPaidActive({ plan: prev.plan, status: prev.status })) return false; // wasn't paying
  if (isPaidActive(next)) return false;                    // still paying (e.g. tier change) → not churn
  return next.plan === 'free' || LOST_STATUSES.has(next.status);
}
