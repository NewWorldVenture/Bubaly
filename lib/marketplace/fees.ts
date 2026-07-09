// lib/marketplace/fees.ts — the marketplace commerce fee engine (pure, tested).
//
// This is the money math behind "display complete fee transparency before
// checkout" and configurable platform commissions from the Stripe Commerce
// Platform spec. It computes, deterministically and DB/Stripe-free:
//   • the platform commission (flat · percentage · tiered · category-specific ·
//     creator-specific · promotional override),
//   • coupon/promo discounts on the subtotal,
//   • the flat Bubaly service fee (reused from lib/stripe/service-fee.ts),
//   • the Stripe processing fee (2.9% + 30¢ US default, configurable),
//   • and the resulting buyer total, platform take, and seller net —
// as an ordered, labeled line-item breakdown suitable for a checkout summary, a
// seller dashboard, or an AI "explain these fees" answer.
//
// Every amount is integer cents and never negative. Security deposits are held,
// not revenue, so they are tracked separately and excluded from seller/platform
// income (see lib/stripe rental-deposit flows for the hold/release lifecycle).

import { DEFAULT_SERVICE_FEE_CENTS } from '@/lib/stripe/service-fee';

/** Stripe's standard US card processing fee: 2.9% + 30¢. Configurable per call. */
export const STRIPE_PERCENT_BPS = 290; // basis points (2.90%)
export const STRIPE_FIXED_CENTS = 30;

/** How a platform commission is calculated. */
export type CommissionRule =
  | { kind: 'flat'; cents: number }
  | { kind: 'percentage'; bps: number }
  /**
   * Bracket-based tiers: the subtotal selects ONE bracket and its bps applies to
   * the whole subtotal. `upToCents: null` is the final, open-ended bracket.
   * Tiers are evaluated in order; the first bracket whose ceiling the subtotal
   * does not exceed wins.
   */
  | { kind: 'tiered'; tiers: { upToCents: number | null; bps: number }[] };

/** Which side absorbs the Stripe processing fee. Default: the platform. */
export type StripeFeePayer = 'platform' | 'seller' | 'buyer';

/** Configurable commission policy with category- and creator-specific overrides. */
export interface CommissionPolicy {
  default: CommissionRule;
  byCategory?: Record<string, CommissionRule>;
  byCreator?: Record<string, CommissionRule>;
}

/** A promotional discount / fee override applied to a single checkout. */
export interface PromoOverride {
  code?: string;
  /** Flat amount off the subtotal (cents). */
  discountCents?: number;
  /** Percentage off the subtotal (basis points). */
  discountBps?: number;
  /** Replaces the resolved commission rule (a promotional fee override). */
  feeOverride?: CommissionRule;
}

export interface FeeInput {
  /** Price the buyer pays the seller for the item/rental (cents, pre-discount). */
  subtotalCents: number;
  policy: CommissionPolicy;
  category?: string | null;
  creatorId?: string | null;
  promo?: PromoOverride | null;
  /** Refundable security deposit — held, not revenue. */
  depositCents?: number;
  /** Tax computed upstream (tax hooks live elsewhere); passed through to the total. */
  taxCents?: number;
  /** Flat Bubaly service fee; defaults to the configured $0.90. */
  serviceFeeCents?: number;
  stripePercentBps?: number;
  stripeFixedCents?: number;
  stripeFeePayer?: StripeFeePayer;
}

export interface FeeLine {
  key: string;
  label: string;
  /** Signed cents from the BUYER's perspective (positive = adds to what they pay). */
  amountCents: number;
}

export interface FeeBreakdown {
  subtotalCents: number;       // after any promo discount
  discountCents: number;       // promo/coupon applied to subtotal
  depositCents: number;        // held separately (refundable)
  taxCents: number;
  marketplaceFeeCents: number; // platform commission on the discounted subtotal
  serviceFeeCents: number;     // flat Bubaly service fee (buyer-paid)
  stripeFeeCents: number;      // processing fee on the buyer total
  stripeFeePayer: StripeFeePayer;
  buyerTotalCents: number;     // what the buyer is charged
  platformReceivesCents: number; // platform net (commission + service fee − Stripe fee if platform pays)
  sellerNetCents: number;      // seller payout (subtotal − commission − Stripe fee if seller pays)
  /** Ordered, labeled buyer-facing summary lines. */
  lines: FeeLine[];
}

const clampCents = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
const bps = (amount: number, basisPoints: number): number => clampCents((amount * basisPoints) / 10_000);

/** Resolve which commission rule applies: promo override → creator → category → default. */
export function resolveCommissionRule(input: Pick<FeeInput, 'policy' | 'category' | 'creatorId' | 'promo'>): CommissionRule {
  const { policy, category, creatorId, promo } = input;
  if (promo?.feeOverride) return promo.feeOverride;
  if (creatorId && policy.byCreator?.[creatorId]) return policy.byCreator[creatorId];
  if (category && policy.byCategory?.[category]) return policy.byCategory[category];
  return policy.default;
}

/** Apply a commission rule to a (discounted) subtotal → commission cents. */
export function commissionFor(rule: CommissionRule, subtotalCents: number): number {
  const sub = clampCents(subtotalCents);
  switch (rule.kind) {
    case 'flat':
      return Math.min(sub, clampCents(rule.cents)); // never exceed the sale
    case 'percentage':
      return Math.min(sub, bps(sub, rule.bps));
    case 'tiered': {
      for (const tier of rule.tiers) {
        if (tier.upToCents === null || sub <= tier.upToCents) return Math.min(sub, bps(sub, tier.bps));
      }
      // No open-ended bracket matched: fall back to the last tier's bps.
      const last = rule.tiers[rule.tiers.length - 1];
      return last ? Math.min(sub, bps(sub, last.bps)) : 0;
    }
  }
}

/** The promo/coupon discount applied to a subtotal (never below zero). */
export function promoDiscountFor(promo: PromoOverride | null | undefined, subtotalCents: number): number {
  if (!promo) return 0;
  const sub = clampCents(subtotalCents);
  const flat = clampCents(promo.discountCents ?? 0);
  const pct = promo.discountBps ? bps(sub, promo.discountBps) : 0;
  return Math.min(sub, flat + pct);
}

/**
 * Compute the full, transparent fee breakdown for one checkout. Buyer pays
 * subtotal (post-discount) + deposit + tax + service fee. The platform commission
 * and the Stripe processing fee are then allocated per policy so seller net +
 * platform net + Stripe fee always reconcile against the revenue (subtotal +
 * service fee); the deposit is held separately and excluded from income.
 */
export function computeFees(input: FeeInput): FeeBreakdown {
  const gross = clampCents(input.subtotalCents);
  const discountCents = promoDiscountFor(input.promo, gross);
  const subtotalCents = gross - discountCents;

  const depositCents = clampCents(input.depositCents ?? 0);
  const taxCents = clampCents(input.taxCents ?? 0);
  const serviceFeeCents = clampCents(input.serviceFeeCents ?? DEFAULT_SERVICE_FEE_CENTS);

  const rule = resolveCommissionRule(input);
  const marketplaceFeeCents = commissionFor(rule, subtotalCents);

  // Buyer is charged the sale + refundable deposit + tax + flat service fee.
  const buyerTotalCents = subtotalCents + depositCents + taxCents + serviceFeeCents;

  // Stripe processing fee is computed on the full amount the card is charged.
  const stripePercentBps = input.stripePercentBps ?? STRIPE_PERCENT_BPS;
  const stripeFixedCents = input.stripeFixedCents ?? STRIPE_FIXED_CENTS;
  const stripeFeeCents = buyerTotalCents > 0 ? bps(buyerTotalCents, stripePercentBps) + stripeFixedCents : 0;
  const stripeFeePayer: StripeFeePayer = input.stripeFeePayer ?? 'platform';

  // Allocate the Stripe fee to whoever absorbs it.
  const sellerStripe = stripeFeePayer === 'seller' ? stripeFeeCents : 0;
  const platformStripe = stripeFeePayer === 'platform' ? stripeFeeCents : 0;

  const sellerNetCents = Math.max(0, subtotalCents - marketplaceFeeCents - sellerStripe);
  const platformReceivesCents = Math.max(0, marketplaceFeeCents + serviceFeeCents - platformStripe);

  const lines: FeeLine[] = [
    { key: 'subtotal', label: 'Subtotal', amountCents: subtotalCents },
  ];
  if (discountCents > 0) lines.push({ key: 'discount', label: input.promo?.code ? `Discount (${input.promo.code})` : 'Discount', amountCents: -discountCents });
  if (depositCents > 0) lines.push({ key: 'deposit', label: 'Refundable security deposit', amountCents: depositCents });
  if (taxCents > 0) lines.push({ key: 'tax', label: 'Tax', amountCents: taxCents });
  if (serviceFeeCents > 0) lines.push({ key: 'service_fee', label: 'Service fee', amountCents: serviceFeeCents });
  lines.push({ key: 'total', label: 'Total', amountCents: buyerTotalCents });

  return {
    subtotalCents, discountCents, depositCents, taxCents,
    marketplaceFeeCents, serviceFeeCents, stripeFeeCents, stripeFeePayer,
    buyerTotalCents, platformReceivesCents, sellerNetCents, lines,
  };
}

/** Dollar string for display, e.g. 1290 → "$12.90"; negatives as "-$1.00". */
export function formatCents(cents: number): string {
  const v = Math.trunc(cents);
  const sign = v < 0 ? '-' : '';
  return `${sign}$${(Math.abs(v) / 100).toFixed(2)}`;
}

/** A one-line, human/AI-readable explanation of where the money goes. */
export function explainFees(b: FeeBreakdown): string {
  const parts = [
    `Buyer pays ${formatCents(b.buyerTotalCents)}`,
    `seller nets ${formatCents(b.sellerNetCents)}`,
    `platform keeps ${formatCents(b.platformReceivesCents)} (${formatCents(b.marketplaceFeeCents)} commission + ${formatCents(b.serviceFeeCents)} service fee)`,
    `Stripe fee ${formatCents(b.stripeFeeCents)} paid by ${b.stripeFeePayer}`,
  ];
  if (b.depositCents > 0) parts.push(`${formatCents(b.depositCents)} deposit held (refundable)`);
  return parts.join(' · ') + '.';
}
