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

// ─── X10 · conversion after value ────────────────────────────────────────────
//
// The headline conversion rate — paid families ÷ all families — measures the
// funnel and the product together, and so measures neither. X10 asks the
// narrower question the strategy actually bets on: of the families that reached
// FIRST VALUE (they saw a real outcome Bubaly produced), how many paid, and how
// long did it take them?
//
// The ordering is load-bearing. A subscription that existed BEFORE the family
// ever saw an outcome did not convert because of it, and counting it would let
// a marketing push flatter the product. Only subscriptions created at or after
// the milestone count.

/** A family that reached first value, and when. */
export type ActivationReach = { familyId: string; reachedAt: string };

/** A subscription row reduced to what X10 needs. */
export type ConversionSubscription = {
  familyId: string;
  plan: string | null;
  status: string | null;
  createdAt: string;
};

export type ConversionAfterValue = {
  /** Families that reached first value — the denominator. */
  families: number;
  /** Of those, how many hold a paid, active subscription created after it. */
  converted: number;
  /** converted / families, 0..1. `null` when nobody has reached first value. */
  rate: number | null;
  /** Median days from first value to the subscription. `null` when none converted. */
  medianDays: number | null;
};

const DAY_MS = 86_400_000;

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * X10 — conversion among families that reached first value.
 *
 * A family that reached the milestone more than once counts once, at its
 * EARLIEST reach: that is when the clock a person would recognise as
 * "time to decide" started.
 */
export function conversionAfterValue(
  activations: ActivationReach[],
  subs: ConversionSubscription[],
): ConversionAfterValue {
  const firstValueAt = new Map<string, number>();
  for (const a of activations) {
    const at = Date.parse(a.reachedAt);
    if (!Number.isFinite(at)) continue;
    const prev = firstValueAt.get(a.familyId);
    if (prev === undefined || at < prev) firstValueAt.set(a.familyId, at);
  }

  const paidAt = new Map<string, number>();
  for (const s of subs) {
    if (!isPaidActive({ plan: s.plan, status: s.status })) continue;
    const at = Date.parse(s.createdAt);
    if (!Number.isFinite(at)) continue;
    const prev = paidAt.get(s.familyId);
    if (prev === undefined || at < prev) paidAt.set(s.familyId, at);
  }

  const daysToPay: number[] = [];
  let converted = 0;
  for (const [familyId, reached] of firstValueAt) {
    const paid = paidAt.get(familyId);
    if (paid === undefined || paid < reached) continue;
    converted++;
    daysToPay.push((paid - reached) / DAY_MS);
  }

  const families = firstValueAt.size;
  return {
    families,
    converted,
    rate: families > 0 ? converted / families : null,
    medianDays: medianOf(daysToPay.map((d) => Math.round(d * 10) / 10)),
  };
}
