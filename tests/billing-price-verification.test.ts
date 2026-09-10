import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PRICES from '@/lib/constants/family-prices.json';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as changePlan } from '@/app/api/billing/change-plan/route';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';

const mocks = vi.hoisted(() => ({
  retrievePrice: vi.fn(), createCustomer: vi.fn(), createCheckout: vi.fn(), retrieveSubscription: vi.fn(), updateSubscription: vi.fn(),
  constructEvent: vi.fn(), recordEvent: vi.fn(), markProcessed: vi.fn(), markError: vi.fn(),
  role: 'parent', trace: [] as string[], writes: [] as { table: string; operation: string; value: unknown }[],
  rows: {} as Record<string, Record<string, unknown> | null>,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-a', email: 'fixture@example.test' }, active: { role: mocks.role, familyId: 'family-a', family: { name: 'Fixture family' } } }) }));
vi.mock('@/lib/supabase/server', () => {
  const db = { from: (table: string) => {
    const builder = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: mocks.rows[table] ?? null, error: null }),
      upsert: async (value: unknown) => { mocks.writes.push({ table, operation: 'upsert', value }); return { error: null }; },
      insert: async (value: unknown) => { mocks.writes.push({ table, operation: 'insert', value }); return { error: null }; },
      update: (value: unknown) => ({ eq: async () => { mocks.writes.push({ table, operation: 'update', value }); return { error: null }; } }),
    };
    return builder;
  } };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/stripe', async () => {
  const { default: prices } = await import('@/lib/constants/family-prices.json');
  const stripe = { prices: { retrieve: mocks.retrievePrice }, customers: { create: mocks.createCustomer },
    checkout: { sessions: { create: mocks.createCheckout } }, subscriptions: { retrieve: mocks.retrieveSubscription, update: mocks.updateSubscription },
    webhooks: { constructEvent: mocks.constructEvent } };
  return { getStripe: () => stripe, stripeFromKey: () => stripe, STRIPE_PLANS: {
    basic_monthly: prices.stripePrices.basic_monthly.id, basic_annual: prices.stripePrices.basic_annual.id,
    plus_monthly: prices.stripePrices.plus_monthly.id, plus_annual: prices.stripePrices.plus_annual.id,
    family_monthly: prices.stripePrices.basic_monthly.id, family_annual: prices.stripePrices.basic_annual.id,
  } };
});
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => ({}), effectiveSecretKey: () => '' }));
vi.mock('@/lib/stripe/service-fee', () => ({ serviceFeeAddInvoiceItems: () => undefined }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/stripe/webhook', () => ({ recordEvent: mocks.recordEvent, markEventProcessed: mocks.markProcessed, markEventError: mocks.markError }));
vi.mock('@/lib/referrals/server', () => ({ markReferralConverted: async () => {}, rewardConvertedReferral: async () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));

const request = (plan: unknown) => new NextRequest('https://app.example.test/api/billing', { method: 'POST', body: JSON.stringify({ plan }) });
function validPrice(id = PRICES.stripePrices.basic_annual.id) {
  const plan = Object.entries(PRICES.stripePrices).find(([, entry]) => entry.id === id)?.[0] ?? 'basic_annual';
  const annual = plan.endsWith('_annual'); const tier = plan.startsWith('plus') ? PRICES.plus : PRICES.basic;
  return { id, active: true, type: 'recurring', currency: 'usd', unit_amount: annual ? tier.annualCents : tier.monthlyCents,
    billing_scheme: 'per_unit', transform_quantity: null, custom_unit_amount: null,
    recurring: { interval: annual ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' } };
}
function noPaidMutation() {
  expect(mocks.createCustomer).not.toHaveBeenCalled();
  expect(mocks.createCheckout).not.toHaveBeenCalled();
  expect(mocks.updateSubscription).not.toHaveBeenCalled();
  expect(mocks.writes).toEqual([]);
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'parent'; mocks.trace = []; mocks.writes = [];
  mocks.rows = { subscriptions: { plan: 'basic', status: 'active', provider_ref: 'sub-existing' }, billing_customers: null };
  mocks.retrievePrice.mockReset().mockImplementation(async (id: string) => { mocks.trace.push('price'); return validPrice(id); });
  mocks.createCustomer.mockReset().mockImplementation(async () => { mocks.trace.push('customer'); return { id: 'cus-fixture' }; });
  mocks.createCheckout.mockReset().mockImplementation(async () => { mocks.trace.push('checkout'); return { id: 'cs-fixture', url: 'https://checkout.example.test' }; });
  mocks.retrieveSubscription.mockReset().mockResolvedValue({ items: { data: [{ id: 'si-fixture' }] } });
  mocks.updateSubscription.mockReset().mockImplementation(async () => { mocks.trace.push('subscription-update'); return {}; });
  mocks.recordEvent.mockResolvedValue({ outcome: 'claimed', claimToken: 'claim-fixture' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each([['checkout', checkout], ['change-plan', changePlan]] as const)('%s price verification', (_name, route) => {
  it.each(['__proto__', 'constructor', 'toString', 'unknown', [], ['basic_annual'], {}, true, 12, null])('rejects invalid plan %j before reading a price', async plan => {
    const response = await route(request(plan));
    expect(response.status).toBe(400); expect(mocks.retrievePrice).not.toHaveBeenCalled(); noPaidMutation();
  });

  it('keeps the parent-only billing gate', async () => {
    mocks.role = 'child';
    expect((await route(request('basic_annual'))).status).toBe(403);
    expect(mocks.retrievePrice).not.toHaveBeenCalled(); noPaidMutation();
  });

  it.each([
    { active: false }, { currency: 'eur' }, { unit_amount: 12999 }, { type: 'one_time' }, { billing_scheme: 'tiered' },
    { recurring: { interval: 'month', interval_count: 12, usage_type: 'licensed' } },
    { recurring: { interval: 'year', interval_count: 2, usage_type: 'licensed' } },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'metered' } },
  ])('returns unavailable and makes no paid mutation for wrong price terms %j', async overrides => {
    mocks.retrievePrice.mockResolvedValue({ ...validPrice(), ...overrides });
    const response = await route(request('basic_annual'));
    expect(response.status).toBe(503); noPaidMutation();
  });

  it('returns unavailable and makes no paid mutation when Stripe price retrieval fails', async () => {
    mocks.retrievePrice.mockRejectedValue(new Error('provider timed out'));
    expect((await route(request('basic_annual'))).status).toBe(503); noPaidMutation();
  });

  it('waits for the provider read before permitting any customer or subscription change', async () => {
    let resolve!: (value: ReturnType<typeof validPrice>) => void;
    mocks.retrievePrice.mockReturnValue(new Promise(done => { resolve = done; }));
    const response = route(request('basic_annual'));
    await vi.waitFor(() => expect(mocks.retrievePrice).toHaveBeenCalledTimes(1));
    noPaidMutation(); resolve({ ...validPrice(), unit_amount: 1 });
    expect((await response).status).toBe(503); noPaidMutation();
  });
});

it('Checkout uses the verified current annual price before creating a customer', async () => {
  expect((await checkout(request('basic_annual'))).status).toBe(200);
  expect(mocks.trace).toEqual(['price', 'customer', 'checkout']);
  expect(mocks.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ line_items: [{ price: PRICES.stripePrices.basic_annual.id, quantity: 1 }] }));
});
it('a subscription change uses the verified Plus annual price', async () => {
  expect((await changePlan(request('plus_annual'))).status).toBe(200);
  expect(mocks.trace).toEqual(['price', 'subscription-update']);
  expect(mocks.updateSubscription).toHaveBeenCalledWith('sub-existing', expect.objectContaining({ items: [{ id: 'si-fixture', price: PRICES.stripePrices.plus_annual.id }] }));
  expect(mocks.createCheckout).not.toHaveBeenCalled();
});
it('a Free family uses the same verified price when plan change falls back to Checkout', async () => {
  mocks.rows.subscriptions = { plan: 'free', status: 'active', provider_ref: null };
  expect((await changePlan(request('plus_annual'))).status).toBe(200);
  expect(mocks.trace).toEqual(['price', 'customer', 'checkout']);
  expect(mocks.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ line_items: [{ price: PRICES.stripePrices.plus_annual.id, quantity: 1 }] }));
});
it('legacy Family annual Checkout selects Basic annual and is also accepted by change-plan', async () => {
  expect((await checkout(request('family_annual'))).status).toBe(200);
  expect(mocks.retrievePrice).toHaveBeenCalledWith(PRICES.stripePrices.basic_annual.id);
  mocks.rows.subscriptions = { plan: 'basic_annual', status: 'active', provider_ref: 'sub-existing' };
  const response = await changePlan(request('family_annual'));
  expect(await response.json()).toMatchObject({ ok: true, changed: false });
  expect(mocks.updateSubscription).not.toHaveBeenCalled();
});

describe('subscription webhook price history', () => {
  const known = Object.entries(PRICES.stripePrices).flatMap(([plan, entry]) => [entry.id, ...entry.previousIds].map(id => ({ id, slug: plan.replace('_monthly', '') })));
  function event(priceId: string) {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
    mocks.constructEvent.mockReturnValue({ id: 'evt-fixture', type: 'customer.subscription.updated', data: { object: {
      id: 'sub-fixture', metadata: { family_id: 'family-a' }, customer: 'cus-fixture', items: { data: [{ price: { id: priceId } }] },
      status: 'active', current_period_end: 1_900_000_000, cancel_at_period_end: false,
    } } });
    return new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}' });
  }
  it.each(known)('preserves $slug entitlement for current or historical price $id', async ({ id, slug }) => {
    const response = await webhook(event(id));
    expect(response.status).toBe(200);
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', operation: 'upsert', value: expect.objectContaining({ plan: slug }) }));
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });
  it('retains custom environment-configured price mapping', async () => {
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_custom_annual');
    expect((await webhook(event('price_custom_annual'))).status).toBe(200);
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', value: expect.objectContaining({ plan: 'plus_annual' }) }));
  });
  it('rejects an unknown price without writing a free or incorrect subscription', async () => {
    expect((await webhook(event('price_unknown'))).status).toBe(500);
    expect(mocks.writes).toEqual([]); expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.markError).toHaveBeenCalledTimes(1);
  });
});
