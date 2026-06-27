import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SERVICE_FEE_CENTS, resolveServiceFeeCents, formatServiceFee, serviceFeeEnabled,
  serviceFeeAddInvoiceItems, serviceFeeApplicationAmount,
} from '@/lib/stripe/service-fee';

describe('resolveServiceFeeCents', () => {
  it('defaults to $0.90', () => {
    expect(DEFAULT_SERVICE_FEE_CENTS).toBe(90);
    expect(resolveServiceFeeCents(null)).toBe(90);
    expect(resolveServiceFeeCents({})).toBe(90);
    expect(resolveServiceFeeCents({ service_fee_cents: null })).toBe(90);
  });
  it('honors a configured value', () => {
    expect(resolveServiceFeeCents({ service_fee_cents: 150 })).toBe(150);
    expect(resolveServiceFeeCents({ service_fee_cents: 0 })).toBe(0);
  });
  it('ignores invalid values', () => {
    expect(resolveServiceFeeCents({ service_fee_cents: -5 })).toBe(90);
    expect(resolveServiceFeeCents({ service_fee_cents: NaN })).toBe(90);
  });
});

describe('formatServiceFee', () => {
  it('formats cents as dollars', () => {
    expect(formatServiceFee(90)).toBe('$0.90');
    expect(formatServiceFee(150)).toBe('$1.50');
  });
});

describe('serviceFeeEnabled', () => {
  it('requires enabled and a positive fee', () => {
    expect(serviceFeeEnabled({ enabled: true, service_fee_cents: 90 })).toBe(true);
    expect(serviceFeeEnabled({ enabled: false, service_fee_cents: 90 })).toBe(false);
    expect(serviceFeeEnabled({ enabled: true, service_fee_cents: 0 })).toBe(false);
    expect(serviceFeeEnabled(null)).toBe(false);
  });
});

describe('serviceFeeAddInvoiceItems', () => {
  it('returns the price line when enabled with a price id', () => {
    expect(serviceFeeAddInvoiceItems({ enabled: true, service_fee_cents: 90, service_fee_price_id: 'price_abc' }))
      .toEqual([{ price: 'price_abc', quantity: 1 }]);
  });
  it('returns undefined when disabled or no price id', () => {
    expect(serviceFeeAddInvoiceItems({ enabled: false, service_fee_price_id: 'price_abc' })).toBeUndefined();
    expect(serviceFeeAddInvoiceItems({ enabled: true, service_fee_cents: 90 })).toBeUndefined();
    expect(serviceFeeAddInvoiceItems({ enabled: true, service_fee_cents: 90, service_fee_price_id: '  ' })).toBeUndefined();
  });
});

describe('serviceFeeApplicationAmount', () => {
  it('is the fee when enabled, else 0', () => {
    expect(serviceFeeApplicationAmount({ enabled: true, service_fee_cents: 90 })).toBe(90);
    expect(serviceFeeApplicationAmount({ enabled: false, service_fee_cents: 90 })).toBe(0);
  });
});
