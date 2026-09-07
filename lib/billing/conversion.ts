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
// The ordering is load-bearing. A family that was already paying BEFORE it ever
// saw an outcome did not convert because of it, and counting it would let a
// marketing push flatter the product. Only families that started paying at or
// after the milestone count.
//
// WHICH TIMESTAMP IS "STARTED PAYING" — and which one is NOT. This function
// used to be handed `subscriptions.created_at`, and that column cannot answer
// the question in this repository: `ensureFamily` and the onboarding action
// insert exactly ONE `subscriptions` row per family at family creation, on plan
// 'free' / status 'trialing', and the Stripe webhook, the change-plan route and
// the admin action all UPDATE that same row in place. `created_at` is therefore
// always the family's creation instant, always earlier than any activation
// event, so the `paid >= reached` guard rejected every family and `converted`
// was structurally 0 — a tile reading "0%" forever and presenting it as a
// measurement.
//
// So the caller must supply the moment the family actually went paid, and say
// where it got it. `lib/metric/strategy-server.ts` prefers the billing EVENT
// (the `admin_notifications` row the webhook writes once, on the paid
// transition) and falls back to the row's own `updated_at`, which the
// `trg_set_updated_at` trigger moves on every write — an upper bound on the
// conversion instant, not the instant itself. `basis` carries that distinction
// out to the UI so an approximate median is never rendered as an exact one.

/** A family that reached first value, and when. */
export type ActivationReach = { familyId: string; reachedAt: string };

/** How a `paidAt` was obtained — the two are not equally precise. */
export type PaidAtBasis = 'event' | 'row_updated_at';

/** A subscription row reduced to what X10 needs. */
export type ConversionSubscription = {
  familyId: string;
  plan: string | null;
  status: string | null;
  /**
   * When this family started paying.
   *
   * NEVER `subscriptions.created_at` — see the note above; that column records
   * family creation here. Pass the billing event's timestamp when one exists,
   * or the paid row's `updated_at` as a documented approximation.
   */
  paidAt: string;
  /** Where `paidAt` came from, so the result can say how exact it is. */
  basis?: PaidAtBasis;
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
  /**
   * True when at least one counted conversion was dated from a row's
   * `updated_at` rather than from a billing event — so `medianDays` is an upper
   * bound, and the surface must say so rather than print it as measured.
   */
  medianDaysApproximate: boolean;
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

  const paidAt = new Map<string, { at: number; basis: PaidAtBasis }>();
  for (const s of subs) {
    if (!isPaidActive({ plan: s.plan, status: s.status })) continue;
    const at = Date.parse(s.paidAt);
    if (!Number.isFinite(at)) continue;
    const prev = paidAt.get(s.familyId);
    if (prev === undefined || at < prev.at) paidAt.set(s.familyId, { at, basis: s.basis ?? 'event' });
  }

  const daysToPay: number[] = [];
  let converted = 0;
  let approximate = false;
  for (const [familyId, reached] of firstValueAt) {
    const paid = paidAt.get(familyId);
    if (paid === undefined || paid.at < reached) continue;
    converted++;
    if (paid.basis === 'row_updated_at') approximate = true;
    daysToPay.push((paid.at - reached) / DAY_MS);
  }

  const families = firstValueAt.size;
  return {
    families,
    converted,
    rate: families > 0 ? converted / families : null,
    medianDays: medianOf(daysToPay.map((d) => Math.round(d * 10) / 10)),
    medianDaysApproximate: approximate,
  };
}
