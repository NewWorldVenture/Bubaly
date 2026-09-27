import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SERVICE_FEE_CENTS, resolveServiceFeeCents, formatServiceFee, serviceFeeEnabled,
  serviceFeeAddInvoiceItems, serviceFeeApplicationAmount,
} from '@/lib/stripe/service-fee';
import { formatCents } from '@/lib/wallet/ledger';

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
  it('formats the fee as money in the reader\'s convention, in the plans\' currency', () => {
    // Expected text is the shared formatter's output for an explicit locale, in
    // USD — the catalogue currency the fee is charged in — not a typed literal.
    for (const locale of ['en-US', 'de-DE'] as const) {
      expect(formatServiceFee(90, locale)).toBe(formatCents(90, 'USD', locale));
      expect(formatServiceFee(150, locale)).toBe(formatCents(150, 'USD', locale));
      expect(formatServiceFee(90.9, locale), 'a fractional cent is truncated').toBe(formatCents(90, 'USD', locale));
      expect(formatServiceFee(-5, locale), 'a negative fee reads as nothing').toBe(formatCents(0, 'USD', locale));
    }
    // The locale is honoured, not ignored: a German reader does not get American money.
    expect(formatServiceFee(90, 'de-DE')).not.toBe(formatServiceFee(90, 'en-US'));
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
