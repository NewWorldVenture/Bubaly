import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_COMMISSION_POLICY,
  marketplaceServiceFeeCents,
  orderFeeBreakdown,
} from '@/lib/marketplace/fee-policy';

describe('marketplace fee policy', () => {
  it('charges no commission on an intra-family sale', () => {
    expect(MARKETPLACE_COMMISSION_POLICY.default).toEqual({ kind: 'flat', cents: 0 });
  });

  describe('marketplaceServiceFeeCents (honest gating)', () => {
    it('is 0 when settings are absent', () => {
      expect(marketplaceServiceFeeCents(null)).toBe(0);
      expect(marketplaceServiceFeeCents(undefined)).toBe(0);
    });
    it('is 0 when the fee is configured but NOT enabled', () => {
      expect(marketplaceServiceFeeCents({ enabled: false, service_fee_cents: 250 })).toBe(0);
    });
    it('is the configured amount when enabled', () => {
      expect(marketplaceServiceFeeCents({ enabled: true, service_fee_cents: 250 })).toBe(250);
    });
    it('falls back to the $0.90 default when enabled without an explicit amount', () => {
      expect(marketplaceServiceFeeCents({ enabled: true })).toBe(90);
    });
  });

  describe('orderFeeBreakdown', () => {
    it('with no fee: buyer pays the sale price and seller receives all of it', () => {
      const b = orderFeeBreakdown(5000, 0);
      expect(b.buyerTotalCents).toBe(5000);
      expect(b.sellerNetCents).toBe(5000);
      expect(b.marketplaceFeeCents).toBe(0);
      expect(b.serviceFeeCents).toBe(0);
      // platform takes nothing on a fee-free exchange
      expect(b.platformReceivesCents).toBe(0);
    });

    it('with a service fee: only the buyer total grows; the seller still nets the full sale', () => {
      const b = orderFeeBreakdown(5000, 90);
      expect(b.buyerTotalCents).toBe(5090);
      expect(b.sellerNetCents).toBe(5000);
      expect(b.serviceFeeCents).toBe(90);
      expect(b.lines.find((l) => l.key === 'service_fee')?.amountCents).toBe(90);
      expect(b.lines.find((l) => l.key === 'total')?.amountCents).toBe(5090);
    });

    // N20: no card is charged for a marketplace order, so there is no
    // processing fee to net out of the service fee. With the engine's default
    // 2.9% + 30¢ allocated, a $20.00 order with the 90¢ fee told the buyer
    // "$0.90 service fee" and the seller "Bubaly takes $0.00".
    it('what the buyer pays less what the seller receives is what Bubaly takes', () => {
      for (const amount of [100, 2000, 5000, 123_456]) {
        for (const fee of [0, 90, 250]) {
          const b = orderFeeBreakdown(amount, fee);
          expect(b.stripeFeeCents, `${amount}/${fee}`).toBe(0);
          expect(b.buyerTotalCents - b.sellerNetCents, `${amount}/${fee}`).toBe(b.platformReceivesCents);
          expect(b.platformReceivesCents, `${amount}/${fee}`).toBe(fee);
        }
      }
      expect(orderFeeBreakdown(2000, 90)).toMatchObject({ buyerTotalCents: 2090, sellerNetCents: 2000, platformReceivesCents: 90 });
    });

    it('clamps a non-positive amount to a zero breakdown', () => {
      const b = orderFeeBreakdown(0, 0);
      expect(b.buyerTotalCents).toBe(0);
      expect(b.sellerNetCents).toBe(0);
    });
  });
});
