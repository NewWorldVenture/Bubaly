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
