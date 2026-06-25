// lib/wallet/fees.ts — Family Wallet fee model. PURE + tested.
//
// Implements the published pricing (see product screenshots): a funded
// transaction (gift / top-up) is charged Stripe PROCESSING plus a Bubaly
// SERVICE FEE that depends on the family's plan tier. The child always receives
// the full gift amount — fees are added on top, never skimmed from the gift, and
// must be disclosed before payment (compliance).
//
//   Free  ($0.99 service fee):  $50 gift → $1.75 processing + $0.99 = $52.74 charged
//   Basic ($0.49 reduced fee):  $50 gift → $1.75 processing + $0.49 = $52.24 charged
//   Plus  ($0 — no fee):        $50 gift → $1.75 processing + $0.00 = $51.75 charged
//
// Processing mirrors Stripe standard US online card pricing: 2.9% + $0.30.

export type WalletTier = 'free' | 'basic' | 'plus';

/** Stripe standard US online card pricing. */
export const STRIPE_PERCENT = 0.029;
export const STRIPE_FIXED_CENTS = 30;

/** Bubaly per-transaction service fee by plan tier (cents). */
export const SERVICE_FEE_CENTS: Record<WalletTier, number> = {
  free: 99,
  basic: 49,
  plus: 0,
};

export type FeeBreakdown = {
  /** The amount the child receives (the gift/funding amount). */
  amountCents: number;
  /** Stripe processing cost (2.9% + $0.30). */
  processingCents: number;
  /** Bubaly service fee for this tier. */
  serviceFeeCents: number;
  /** What the giver/parent is charged in total. */
  totalChargedCents: number;
  tier: WalletTier;
};

/** Stripe processing fee for an amount charged to a card (cents). */
export function processingFeeCents(amountChargedCents: number): number {
  const amt = Math.max(0, Math.trunc(amountChargedCents));
  return Math.round(amt * STRIPE_PERCENT) + STRIPE_FIXED_CENTS;
}

/**
 * Full fee breakdown for funding `amountCents` to a child under `tier`.
 * Processing is computed on the gift amount (the dominant base; this matches the
 * published examples and keeps the charge predictable for the giver).
 */
export function computeFunding(amountCents: number, tier: WalletTier): FeeBreakdown {
  const amount = Math.max(0, Math.trunc(amountCents));
  const processing = amount > 0 ? processingFeeCents(amount) : 0;
  const serviceFee = amount > 0 ? SERVICE_FEE_CENTS[tier] : 0;
  return {
    amountCents: amount,
    processingCents: processing,
    serviceFeeCents: serviceFee,
    totalChargedCents: amount + processing + serviceFee,
    tier,
  };
}

/** Total fees on top of the gift (processing + service). */
export function totalFeesCents(amountCents: number, tier: WalletTier): number {
  const b = computeFunding(amountCents, tier);
  return b.processingCents + b.serviceFeeCents;
}

/** Human label for the service-fee column of the pricing matrix. */
export function serviceFeeLabel(tier: WalletTier): 'Yes' | 'Reduced' | 'None' {
  return tier === 'free' ? 'Yes' : tier === 'basic' ? 'Reduced' : 'None';
}
