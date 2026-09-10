import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PRICES from '@/lib/constants/family-prices.json';
import { catalogPlanForPrice, canonicalStripePlan, currentStripePriceId, isStripePlanKey, verifyStripePlanPrice, type CanonicalStripePlan } from '@/lib/billing/price-catalog';

const cases = [
  ['basic_monthly', 'basic', 1204, 'month'], ['basic_annual', 'basic_annual', 11988, 'year'],
  ['plus_monthly', 'plus', 3011, 'month'], ['plus_annual', 'plus_annual', 29988, 'year'],
] as const;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the current Stripe price catalogue', () => {
  it.each(cases)('replaces the known previous %s price and retains entitlement for both versions', (plan, slug) => {
    const entry = PRICES.stripePrices[plan];
    expect(currentStripePriceId(plan, entry.previousIds[0])).toBe(entry.id);
    expect(currentStripePriceId(plan, entry.id)).toBe(entry.id);
    expect(catalogPlanForPrice(entry.id)).toBe(slug);
    for (const previous of entry.previousIds) expect(catalogPlanForPrice(previous)).toBe(slug);
  });

  it('preserves custom, test, and missing price configuration', () => {
    for (const value of ['', 'price_custom_account', 'price_test_fixture']) {
      expect(currentStripePriceId('basic_monthly', value)).toBe(value);
    }
    expect(currentStripePriceId('basic_monthly', PRICES.stripePrices.plus_monthly.previousIds[0])).toBe(PRICES.stripePrices.plus_monthly.previousIds[0]);
    expect(catalogPlanForPrice('price_unknown')).toBeNull();
  });

  it.each([undefined, null, 123, true, {}, [], ['basic_monthly'], '__proto__', 'constructor', 'toString', '', 'BASIC_MONTHLY'])('rejects untrusted plan input %j', value => {
    expect(isStripePlanKey(value)).toBe(false);
    expect(catalogPlanForPrice(value)).toBeNull();
  });

  it('keeps legacy Family selections on the matching Basic cadence', () => {
    expect(isStripePlanKey('family_monthly')).toBe(true);
    expect(isStripePlanKey('family_annual')).toBe(true);
    expect(canonicalStripePlan('family_monthly')).toBe('basic_monthly');
    expect(canonicalStripePlan('family_annual')).toBe('basic_annual');
    expect(currentStripePriceId('family_annual', PRICES.stripePrices.basic_annual.previousIds[0])).toBe(PRICES.stripePrices.basic_annual.id);
  });

  it('maps the real STRIPE_PLANS environment ladder without replacing custom/test values', async () => {
    vi.resetModules();
    vi.stubEnv('STRIPE_PRICE_BASIC_MONTHLY', PRICES.stripePrices.basic_monthly.previousIds[0]);
    vi.stubEnv('STRIPE_PRICE_BASIC_ANNUAL', undefined);
    vi.stubEnv('STRIPE_PRICE_FAMILY_MONTHLY', 'price_custom_family_month');
    vi.stubEnv('STRIPE_PRICE_FAMILY_ANNUAL', PRICES.stripePrices.basic_annual.previousIds[0]);
    vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_test_plus_month');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', PRICES.stripePrices.plus_annual.previousIds[0]);
    const { STRIPE_PLANS } = await import('@/lib/stripe');
    expect(STRIPE_PLANS).toEqual({
      basic_monthly: PRICES.stripePrices.basic_monthly.id,
      basic_annual: PRICES.stripePrices.basic_annual.id,
      plus_monthly: 'price_test_plus_month', plus_annual: PRICES.stripePrices.plus_annual.id,
      family_monthly: 'price_custom_family_month', family_annual: PRICES.stripePrices.basic_annual.id,
    });
  });
});

describe('provider price verification', () => {
  function fixture(plan: CanonicalStripePlan = 'basic_annual') {
    const item = cases.find(([key]) => key === plan)!;
    const price = { id: PRICES.stripePrices[plan].id, active: true, type: 'recurring', currency: 'usd', unit_amount: item[2],
      unit_amount_decimal: String(item[2]), billing_scheme: 'per_unit', transform_quantity: null, custom_unit_amount: null,
      recurring: { interval: item[3], interval_count: 1, usage_type: 'licensed' } };
    const retrieve = vi.fn().mockResolvedValue(price);
    return { price, retrieve, stripe: { prices: { retrieve } } as unknown as Pick<Stripe, 'prices'> };
  }

  it.each(cases)('accepts the canonical %s amount and cadence', async (plan) => {
    const f = fixture(plan);
    expect(await verifyStripePlanPrice(f.stripe, plan, f.price.id)).toBe(true);
    expect(f.retrieve).toHaveBeenCalledExactlyOnceWith(f.price.id);
  });

  it.each([
    { id: 'price_other' }, { active: false }, { currency: 'eur' }, { unit_amount: 12999 }, { unit_amount: null },
    { unit_amount_decimal: '11988.5' }, { type: 'one_time' }, { billing_scheme: 'tiered' },
    { transform_quantity: { divide_by: 2, round: 'up' } }, { custom_unit_amount: { enabled: true } },
    { recurring: null }, { recurring: { interval: 'month', interval_count: 12, usage_type: 'licensed' } },
    { recurring: { interval: 'year', interval_count: 2, usage_type: 'licensed' } },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'metered' } },
  ])('rejects a provider price with mismatched terms %j', async changes => {
    const f = fixture();
    f.retrieve.mockResolvedValue({ ...f.price, ...changes });
    expect(await verifyStripePlanPrice(f.stripe, 'basic_annual', f.price.id)).toBe(false);
  });

  it('rejects unreadable provider prices without authorizing a purchase', async () => {
    const f = fixture(); f.retrieve.mockRejectedValue(new Error('provider unavailable'));
    expect(await verifyStripePlanPrice(f.stripe, 'basic_annual', f.price.id)).toBe(false);
  });

  it('accepts a custom/test price only when its real billing terms match', async () => {
    const f = fixture(); f.price.id = 'price_test_basic_annual';
    expect(await verifyStripePlanPrice(f.stripe, 'family_annual', f.price.id)).toBe(true);
  });
});
