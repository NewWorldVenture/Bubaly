import { describe, it, expect } from 'vitest';
import {
  computeFees, resolveCommissionRule, commissionFor, promoDiscountFor,
  formatCents, explainFees, STRIPE_FIXED_CENTS,
  type CommissionPolicy, type CommissionRule,
} from '@/lib/marketplace/fees';

const policy: CommissionPolicy = {
  default: { kind: 'percentage', bps: 1000 }, // 10%
  byCategory: { electronics: { kind: 'percentage', bps: 500 } }, // 5%
  byCreator: { 'creator-vip': { kind: 'flat', cents: 199 } },
};

describe('commission rules', () => {
  it('percentage, flat, and tiered math', () => {
    expect(commissionFor({ kind: 'percentage', bps: 1000 }, 10_000)).toBe(1000); // 10% of $100
    expect(commissionFor({ kind: 'flat', cents: 250 }, 10_000)).toBe(250);
    const tiered: CommissionRule = { kind: 'tiered', tiers: [{ upToCents: 5000, bps: 1500 }, { upToCents: null, bps: 800 }] };
    expect(commissionFor(tiered, 4000)).toBe(600);  // ≤$50 → 15%
    expect(commissionFor(tiered, 20_000)).toBe(1600); // >$50 → 8%
  });

  it('a flat commission never exceeds the sale', () => {
    expect(commissionFor({ kind: 'flat', cents: 5000 }, 3000)).toBe(3000);
  });

  it('resolves overrides: promo → creator → category → default', () => {
    expect(resolveCommissionRule({ policy, category: null, creatorId: null })).toEqual(policy.default);
    expect(resolveCommissionRule({ policy, category: 'electronics' })).toEqual(policy.byCategory!.electronics);
    expect(resolveCommissionRule({ policy, category: 'electronics', creatorId: 'creator-vip' })).toEqual(policy.byCreator!['creator-vip']);
    const promoRule: CommissionRule = { kind: 'percentage', bps: 0 };
    expect(resolveCommissionRule({ policy, creatorId: 'creator-vip', promo: { feeOverride: promoRule } })).toEqual(promoRule);
  });
});

describe('promo discounts', () => {
  it('combines flat + percentage and never goes below zero', () => {
    expect(promoDiscountFor({ discountCents: 500, discountBps: 1000 }, 10_000)).toBe(1500); // $5 + 10%
    expect(promoDiscountFor({ discountCents: 99_999 }, 10_000)).toBe(10_000); // capped at subtotal
    expect(promoDiscountFor(null, 10_000)).toBe(0);
  });
});

describe('computeFees', () => {
  it('reconciles buyer total, seller net, and platform take (platform absorbs Stripe fee)', () => {
    const b = computeFees({ subtotalCents: 10_000, policy }); // 10% default, $0.90 service fee
    expect(b.subtotalCents).toBe(10_000);
    expect(b.marketplaceFeeCents).toBe(1000);
    expect(b.serviceFeeCents).toBe(90);
    expect(b.buyerTotalCents).toBe(10_090); // subtotal + service fee
    // Stripe: 2.9% of 10090 + 30 = 293 (rounded) + 30 = 323
    expect(b.stripeFeeCents).toBe(Math.round(10_090 * 0.029) + STRIPE_FIXED_CENTS);
    expect(b.sellerNetCents).toBe(9000); // 10000 - 1000 commission (seller doesn't pay Stripe here)
    // platform = commission + service fee - stripe fee
    expect(b.platformReceivesCents).toBe(1000 + 90 - b.stripeFeeCents);
  });

  it('holds a refundable deposit separately and taxes/deposit flow to the buyer total', () => {
    const b = computeFees({ subtotalCents: 20_000, depositCents: 5000, taxCents: 1650, policy });
    expect(b.depositCents).toBe(5000);
    expect(b.buyerTotalCents).toBe(20_000 + 5000 + 1650 + 90);
    // Deposit is NOT revenue: seller net is only about the subtotal & commission.
    expect(b.sellerNetCents).toBe(20_000 - 2000);
  });

  it('applies a promo discount before commission and shows a discount line', () => {
    const b = computeFees({ subtotalCents: 10_000, policy, promo: { code: 'SAVE20', discountBps: 2000 } });
    expect(b.discountCents).toBe(2000);
    expect(b.subtotalCents).toBe(8000);
    expect(b.marketplaceFeeCents).toBe(800); // 10% of discounted 8000
    expect(b.lines.find((l) => l.key === 'discount')?.amountCents).toBe(-2000);
    expect(b.lines.find((l) => l.key === 'discount')?.label).toContain('SAVE20');
  });

  it('lets the seller absorb the Stripe fee when configured', () => {
    const b = computeFees({ subtotalCents: 10_000, policy, stripeFeePayer: 'seller' });
    expect(b.sellerNetCents).toBe(10_000 - 1000 - b.stripeFeeCents);
    expect(b.platformReceivesCents).toBe(1000 + 90); // platform keeps full commission + service fee
  });

  it('buyer-facing lines end with the total and sum consistently', () => {
    const b = computeFees({ subtotalCents: 10_000, depositCents: 2000, taxCents: 800, policy });
    const positives = b.lines.filter((l) => l.key !== 'total').reduce((s, l) => s + l.amountCents, 0);
    expect(positives).toBe(b.buyerTotalCents);
    expect(b.lines[b.lines.length - 1].key).toBe('total');
  });
});

describe('formatting + explanation', () => {
  it('formats cents and explains the split', () => {
    expect(formatCents(1290)).toBe('$12.90');
    expect(formatCents(-100)).toBe('-$1.00');
    const text = explainFees(computeFees({ subtotalCents: 10_000, depositCents: 5000, policy }));
    expect(text).toContain('Buyer pays');
    expect(text).toContain('deposit held');
  });
});
