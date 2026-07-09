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

    it('clamps a non-positive amount to a zero breakdown', () => {
      const b = orderFeeBreakdown(0, 0);
      expect(b.buyerTotalCents).toBe(0);
      expect(b.sellerNetCents).toBe(0);
    });
  });
});
