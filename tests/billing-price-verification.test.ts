import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import PRICES from '@/lib/constants/family-prices.json';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as changePlan } from '@/app/api/billing/change-plan/route';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';
import { getUserContext, requireUserContext } from '@/lib/supabase/auth';

const mocks = vi.hoisted(() => ({
  retrievePrice: vi.fn(), createCustomer: vi.fn(), createCheckout: vi.fn(), retrieveSubscription: vi.fn(), updateSubscription: vi.fn(), listSubscriptions: vi.fn(),
  // The customer's open Checkout sessions, which both routes close before opening
  // another (tests/a-family-is-never-subscribed-twice.test.ts). None by default.
  listSessions: vi.fn(), expireSession: vi.fn(), retrieveSession: vi.fn(),
  constructEvent: vi.fn(), recordEvent: vi.fn(), markProcessed: vi.fn(), markError: vi.fn(),
  role: 'parent', trace: [] as string[], writes: [] as { table: string; operation: string; value: unknown; options?: unknown }[],
  rows: {} as Record<string, Record<string, unknown> | null>,
  contextState: 'ready' as 'ready' | 'needsFamily' | 'signedOut' | 'unavailable',
  memberships: [{ familyId: 'family-a', role: 'parent' }],
  errors: {} as Record<string, { message: string }>,
  // `matchedNone`: the sync write succeeds but matches no row (C1-S9-62).
  syncFailure: 'none' as 'none' | 'returned' | 'thrown' | 'matchedNone',
  secretKey: 'sk_test_fixture' as string | null,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => {
  const context = () => ({ user: { id: 'user-a', email: 'fixture@example.test' },
    active: { role: mocks.role, familyId: 'family-a', family: { name: 'Fixture family' } },
    memberships: mocks.memberships.map(member => ({ ...member, role: member.familyId === 'family-a' ? mocks.role : member.role, family: { name: 'Fixture family' } })),
  });
  return {
    requireUserContext: vi.fn(async () => context()),
    getUserContext: vi.fn(async () => {
      if (mocks.contextState === 'needsFamily') return { needsFamily: true };
      if (mocks.contextState === 'signedOut') return null;
      if (mocks.contextState === 'unavailable') throw new Error('private context read failure');
      return context();
    }),
  };
});
vi.mock('@/lib/supabase/server', () => {
  const db = { from: (table: string) => {
    const builder = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: mocks.rows[table] ?? null, error: mocks.errors[table] ?? null }),
      // Chainable AND awaitable, for the same reason `update` below is: a real
      // PostgREST upsert supports `.upsert(v)` and `.upsert(v).select().maybeSingle()`,
      // and the billing-customer writer uses the second form to learn what the
      // row now holds. Modelled as `async` this answered 500 to something
      // production handles — and, worse, no unit test in the suite could observe
      // whether an upsert's result was read at all.
      upsert: (value: unknown, options?: unknown) => {
        const settle = () => {
          mocks.writes.push({ table, operation: 'upsert', value, options });
          return { error: null };
        };
        const chain = {
          select: () => chain,
          maybeSingle: async () => {
            const { error } = settle();
            return { data: { ...(value as Record<string, unknown>) }, error };
          },
          single: async () => {
            const { error } = settle();
            return { data: { ...(value as Record<string, unknown>) }, error };
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
            let settled;
            try { settled = settle(); } catch (error) { return Promise.reject(error).then(resolve, reject); }
            return Promise.resolve(settled).then(resolve, reject);
          },
        };
        return chain;
      },
      insert: async (value: unknown) => { mocks.writes.push({ table, operation: 'insert', value }); return { error: null }; },
      // A real PostgREST builder is chainable AND awaitable, so `.update().eq()`
      // and `.update().eq().select()` are both valid. The subscription webhook
      // needs the second form to learn whether the update matched a row (it
      // inserts only when it matched none), so the mock has to model both or it
      // answers 500 to something production handles.
      update: (value: unknown) => {
        const settle = () => {
          mocks.writes.push({ table, operation: 'update', value });
          if (mocks.syncFailure === 'thrown') throw new Error('private sync write failure');
          return { error: mocks.syncFailure === 'returned' ? { message: 'private sync write failure' } : null };
        };
        const chain = {
          eq: () => chain,
          select: async () => {
            const { error } = settle();
            // `rows[table]` is this suite's stand-in for "the row exists".
            if (mocks.syncFailure === 'matchedNone') return { data: [], error };
            return { data: mocks.rows[table] ? [{ id: `${table}-row` }] : [], error };
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
            let settled;
            try { settled = settle(); } catch (error) { return Promise.reject(error).then(resolve, reject); }
            return Promise.resolve(settled).then(resolve, reject);
          },
        };
        return chain;
      },
    };
    return builder;
  } };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/stripe', async () => {
  const { default: prices } = await import('@/lib/constants/family-prices.json');
  const stripe = { prices: { retrieve: mocks.retrievePrice }, customers: { create: mocks.createCustomer },
    checkout: { sessions: { create: mocks.createCheckout, list: mocks.listSessions, expire: mocks.expireSession, retrieve: mocks.retrieveSession } }, subscriptions: { retrieve: mocks.retrieveSubscription, update: mocks.updateSubscription, list: mocks.listSubscriptions },
    webhooks: { constructEvent: mocks.constructEvent } };
  return { getStripe: () => stripe, stripeFromKey: () => stripe, constructWebhookEvent: mocks.constructEvent, STRIPE_PLANS: {
    basic_monthly: prices.stripePrices.basic_monthly.id, basic_annual: prices.stripePrices.basic_annual.id,
    plus_monthly: prices.stripePrices.plus_monthly.id, plus_annual: prices.stripePrices.plus_annual.id,
    family_monthly: prices.stripePrices.basic_monthly.id, family_annual: prices.stripePrices.basic_annual.id,
  } };
});
// A configured deployment: the routes resolve their key and signing secret the
// way lib/stripe/settings does (a missing key is now a 503 before any Stripe call).
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => ({}),
  effectiveSecretKey: () => mocks.secretKey,
  effectiveWebhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET || null,
}));
vi.mock('@/lib/stripe/service-fee', () => ({ serviceFeeAddInvoiceItems: () => undefined }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/stripe/webhook', () => ({ recordEvent: mocks.recordEvent, markEventProcessed: mocks.markProcessed, markEventError: mocks.markError }));
vi.mock('@/lib/referrals/server', () => ({ markReferralConverted: async () => {}, rewardConvertedReferral: async () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));

const request = (plan: unknown) => new NextRequest('https://app.example.test/api/billing', { method: 'POST', body: JSON.stringify({ plan }) });
function subscriptionItem(priceId: string, currentPeriodEnd = 1_900_000_000) {
  return {
    id: `si-${priceId}`, price: { id: priceId }, current_period_end: currentPeriodEnd,
  } satisfies Pick<Stripe.SubscriptionItem, 'id' | 'current_period_end'> & { price: { id: string } };
}
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
  mocks.rows = { subscriptions: { plan: 'basic', status: 'active', provider_ref: 'sub-existing', cancel_at_period_end: false }, billing_customers: null, user_preferences: { active_family_id: 'family-a' } };
  mocks.contextState = 'ready'; mocks.memberships = [{ familyId: 'family-a', role: 'parent' }]; mocks.errors = {};
  mocks.syncFailure = 'none'; mocks.secretKey = 'sk_test_fixture';
  mocks.retrievePrice.mockReset().mockImplementation(async (id: string) => { mocks.trace.push('price'); return validPrice(id); });
  mocks.createCustomer.mockReset().mockImplementation(async () => { mocks.trace.push('customer'); return { id: 'cus-fixture' }; });
  mocks.createCheckout.mockReset().mockImplementation(async () => { mocks.trace.push('checkout'); return { id: 'cs-fixture', url: 'https://checkout.example.test' }; });
  mocks.retrieveSubscription.mockReset().mockResolvedValue({ id: 'sub-existing', status: 'active', cancel_at_period_end: false, items: { data: [{ id: 'si-fixture', price: { id: PRICES.stripePrices.basic_monthly.id } }] } });
  mocks.updateSubscription.mockReset().mockImplementation(async () => { mocks.trace.push('subscription-update'); return {}; });
  mocks.listSubscriptions.mockReset().mockResolvedValue({ data: [] });
  mocks.listSessions.mockReset().mockResolvedValue({ data: [], has_more: false });
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

  it('records the new Stripe customer against a conflict target that can fire', async () => {
    // DATA-014, observed at runtime rather than read out of the source.
    // `billing_customers` keys on `id uuid default gen_random_uuid()` with a
    // separate `unique (family_id)`, so an upsert that does not name the target
    // gets `on conflict (id)` — which the payload never supplies, so the insert
    // is attempted in full and collides with the family_id constraint instead.
    // Both routes used to do exactly that, and the second write for a family
    // failed with 23505 after a real Stripe customer had already been created.
    // Both routes reach the customer-creation branch only when there is no
    // subscription to change in place; change-plan otherwise updates the
    // existing Stripe subscription and never gets here.
    mocks.rows = { ...mocks.rows, subscriptions: { plan: 'free', status: 'active', provider_ref: null, cancel_at_period_end: false }, billing_customers: null };
    expect((await route(request('basic_annual'))).status).toBe(200);
    expect(mocks.createCustomer, 'the fixture must actually take the create-customer branch').toHaveBeenCalled();
    const write = mocks.writes.find(w => w.table === 'billing_customers');
    expect(write, 'the route must record the customer it just created').toBeDefined();
    expect(write!.operation).toBe('upsert');
    expect(write!.options).toEqual({ onConflict: 'family_id' });
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
  mocks.rows.subscriptions = { plan: 'free', status: 'active', provider_ref: null };
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
  mocks.rows.subscriptions = { plan: 'free', status: 'active', provider_ref: null };
  expect((await checkout(request('family_annual'))).status).toBe(200);
  expect(mocks.retrievePrice).toHaveBeenCalledWith(PRICES.stripePrices.basic_annual.id);
  mocks.rows.subscriptions = { plan: 'basic_annual', status: 'active', provider_ref: 'sub-existing' };
  mocks.retrieveSubscription.mockResolvedValue({ id: 'sub-existing', status: 'active', cancel_at_period_end: false, items: { data: [{ id: 'si-fixture', price: { id: PRICES.stripePrices.basic_annual.id } }] } });
  const response = await changePlan(request('family_annual'));
  expect(await response.json()).toMatchObject({ ok: true, changed: false });
  expect(mocks.updateSubscription).not.toHaveBeenCalled();
});

describe('explicit billing review ownership assertions', () => {
  function reviewed(body: Record<string, unknown>) {
    return new NextRequest('https://app.example.test/api/billing/change-plan', { method: 'POST', body: JSON.stringify(body) });
  }
  it.each([
    { expectedUserId: 'user-b', expectedFamilyId: 'family-a' },
    { expectedUserId: 'user-a', expectedFamilyId: 'family-b' },
    { expectedUserId: 'user-b', expectedFamilyId: 'family-b' },
  ])('rejects stale review context before any provider work: %j', async (context) => {
    const response = await changePlan(reviewed({ plan: 'plus_annual', ...context }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'billingReview.contextChanged' });
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(requireUserContext).not.toHaveBeenCalled();
    noPaidMutation();
  });
  it.each([
    { expectedUserId: 'user-a' }, { expectedFamilyId: 'family-a' },
    { expectedUserId: null, expectedFamilyId: 'family-a' },
    { expectedUserId: 'user-a', expectedFamilyId: '' },
    { expectedUserId: ['user-a'], expectedFamilyId: 'family-a' },
    { expectedUserId: 'user-a', expectedFamilyId: { id: 'family-a' } },
  ])('requires a complete string assertion pair when supplied: %j', async (context) => {
    expect((await changePlan(reviewed({ plan: 'plus_annual', ...context }))).status).toBe(400);
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
    noPaidMutation();
  });
  it.each(['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'] as const)('confirms only canonical %s at its verified price, with no extra service fee', async (plan) => {
    mocks.rows.subscriptions = null;
    const response = await changePlan(reviewed({ plan, expectedUserId: 'user-a', expectedFamilyId: 'family-a', amount: 1, priceId: 'price_untrusted' }));
    expect(response.status).toBe(200);
    expect(mocks.retrievePrice).toHaveBeenCalledWith(PRICES.stripePrices[plan].id);
    expect(mocks.createCheckout).toHaveBeenCalledTimes(1);
    const created = mocks.createCheckout.mock.calls[0][0];
    expect(created.line_items).toEqual([{ price: PRICES.stripePrices[plan].id, quantity: 1 }]);
    expect(created.subscription_data).toEqual({ metadata: { family_id: 'family-a' } });
    expect(created).not.toHaveProperty('invoice_creation');
  });
  it('keeps current-plan no-op, role restrictions, and canonical price validation for reviewed requests', async () => {
    const body = { plan: 'basic_monthly', expectedUserId: 'user-a', expectedFamilyId: 'family-a' };
    const response = await changePlan(reviewed(body));
    expect(await response.json()).toMatchObject({ ok: true, changed: false });
    noPaidMutation();
    mocks.role = 'child';
    expect((await changePlan(reviewed(body))).status).toBe(403);
    noPaidMutation();
    mocks.role = 'parent';
    mocks.retrievePrice.mockResolvedValue({ ...validPrice(), unit_amount: 1 });
    expect((await changePlan(reviewed({ ...body, plan: 'plus_annual' }))).status).toBe(503);
    noPaidMutation();
  });
  it.each(['needsFamily', 'signedOut', 'unavailable'] as const)('never invokes provisioning when fresh reviewed context is %s', async state => {
    mocks.contextState = state;
    const response = await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(response.status).toBe(state === 'unavailable' ? 503 : 409);
    expect(getUserContext).toHaveBeenCalledTimes(1);
    expect(requireUserContext).not.toHaveBeenCalled();
    expect(mocks.retrievePrice).not.toHaveBeenCalled();
    noPaidMutation();
  });
  it('rejects an unavailable active-family preference even when the fallback context matches the old review', async () => {
    mocks.memberships.push({ familyId: 'family-b', role: 'parent' });
    mocks.errors.user_preferences = { message: 'private preference failure' };
    const response = await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'changePlan.subscriptionStatusIsTemporarilyUnavailable' });
    expect(requireUserContext).not.toHaveBeenCalled(); expect(mocks.retrievePrice).not.toHaveBeenCalled(); noPaidMutation();
  });
  it.each([null, { active_family_id: null }, { active_family_id: 'foreign-family' }, { active_family_id: 'family-b' }])('rejects ambiguous or different authoritative active-family choice: %j', async preference => {
    mocks.memberships.push({ familyId: 'family-b', role: 'parent' }); mocks.rows.user_preferences = preference;
    const response = await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(response.status).toBe(409);
    expect(requireUserContext).not.toHaveBeenCalled(); expect(mocks.retrievePrice).not.toHaveBeenCalled(); noPaidMutation();
  });
  it('permits the sole unambiguous membership when no preference row exists', async () => {
    mocks.rows.user_preferences = null;
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }))).status).toBe(200);
    expect(requireUserContext).not.toHaveBeenCalled();
    expect(mocks.updateSubscription).toHaveBeenCalledTimes(1);
  });
  it('checks the role on the authoritative active membership rather than an earlier fallback membership', async () => {
    mocks.memberships.push({ familyId: 'family-b', role: 'child' }); mocks.rows.user_preferences = { active_family_id: 'family-b' };
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-b' }))).status).toBe(403);
    expect(requireUserContext).not.toHaveBeenCalled(); expect(mocks.retrievePrice).not.toHaveBeenCalled(); noPaidMutation();
  });
  it.each(['canceled', 'incomplete_expired', 'missing-provider'])('starts one new checkout for a same-plan %s subscription', async kind => {
    mocks.rows.subscriptions = { plan: 'plus_annual', status: kind === 'missing-provider' ? 'active' : kind, provider_ref: kind === 'missing-provider' ? null : 'sub-ended', cancel_at_period_end: false };
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }))).status).toBe(200);
    expect(mocks.createCheckout).toHaveBeenCalledTimes(1);
    expect(mocks.updateSubscription).not.toHaveBeenCalled();
    expect(mocks.retrievePrice).toHaveBeenCalledWith(PRICES.stripePrices.plus_annual.id);
  });
  it('resumes an existing same-plan scheduled cancellation with one verified provider update', async () => {
    mocks.rows.subscriptions = { plan: 'plus_annual', status: 'active', provider_ref: 'sub-existing', cancel_at_period_end: true };
    mocks.retrieveSubscription.mockResolvedValue({ id: 'sub-existing', status: 'active', cancel_at_period_end: true, items: { data: [{ id: 'si-fixture', price: { id: PRICES.stripePrices.plus_annual.id } }] } });
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }))).status).toBe(200);
    expect(mocks.updateSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.updateSubscription).toHaveBeenCalledWith('sub-existing', expect.objectContaining({ cancel_at_period_end: false }));
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
  it('does not repeat a provider update when its actual price already changed but local webhook sync is stale', async () => {
    mocks.retrieveSubscription.mockResolvedValue({ id: 'sub-existing', status: 'active', cancel_at_period_end: false, items: { data: [{ id: 'si-fixture', price: { id: PRICES.stripePrices.plus_annual.id } }] } });
    const response = await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: false, providerUpdated: true, providerRef: 'sub-existing' });
    expect(mocks.retrieveSubscription).toHaveBeenCalledTimes(1);
    noPaidMutation();
  });
  it('does not claim an actual provider no-op when only the local slug matches the requested plan', async () => {
    mocks.rows.subscriptions = { plan: 'plus_annual', status: 'active', provider_ref: 'sub-existing', cancel_at_period_end: false };
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }))).status).toBe(200);
    expect(mocks.updateSubscription).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an already-applied cancellation resume while the local cancellation flag remains stale', async () => {
    mocks.rows.subscriptions = { plan: 'basic', status: 'active', provider_ref: 'sub-existing', cancel_at_period_end: true };
    const response = await changePlan(reviewed({ plan: 'basic_monthly', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(await response.json()).toMatchObject({ changed: false, providerUpdated: true });
    noPaidMutation();
  });
  it.each(['canceled', 'incomplete_expired'])('requires a refreshed local subscription when the provider is already %s', async status => {
    mocks.retrieveSubscription.mockResolvedValue({ id: 'sub-existing', status, cancel_at_period_end: false, items: { data: [{ id: 'si-fixture', price: { id: PRICES.stripePrices.plus_annual.id } }] } });
    expect((await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }))).status).toBe(503);
    noPaidMutation();
  });
  // `matchedNone` since C1-S9-62: the sync asks `.select('id')`, and a write that
  // matched nothing is the same situation as one that failed — Stripe changed,
  // the local row did not — so it must take the same 503, not answer `ok`.
  it.each(['returned', 'thrown', 'matchedNone'] as const)('preserves known provider completion after a %s local sync failure', async failure => {
    mocks.syncFailure = failure;
    const response = await changePlan(reviewed({ plan: 'plus_annual', expectedUserId: 'user-a', expectedFamilyId: 'family-a' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'changePlan.stripeChangedThePlanBut', providerUpdated: true, providerRef: 'sub-existing' });
    expect(mocks.updateSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
});

describe('subscription webhook price history', () => {
  const known = Object.entries(PRICES.stripePrices).flatMap(([plan, entry]) => [entry.id, ...entry.previousIds].map(id => ({ id, slug: plan.replace('_monthly', '') })));
  function event(priceId: string) {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
    const subscription = {
      id: 'sub-fixture', metadata: { family_id: 'family-a' }, customer: 'cus-fixture', items: { data: [subscriptionItem(priceId)], has_more: false },
      status: 'active', cancel_at_period_end: false,
    };
    mocks.constructEvent.mockReturnValue({ id: 'evt-fixture', type: 'customer.subscription.updated', data: { object: subscription } });
    // The webhook persists the subscription's current state from Stripe (PAY-ORDER-001).
    mocks.retrieveSubscription.mockResolvedValue(subscription);
    return new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}' });
  }
  it.each(known)('preserves $slug entitlement for current or historical price $id', async ({ id, slug }) => {
    const response = await webhook(event(id));
    expect(response.status).toBe(200);
    // 'update', not 'upsert': the webhook stopped upserting on `family_id`,
    // which was never a target Postgres could infer (no unique index on that
    // column), so every delivery had failed at planning time. What this asserts
    // is unchanged — the family's subscription row carries the mapped plan.
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', operation: 'update', value: expect.objectContaining({ plan: slug, current_period_end: new Date(1_900_000_000_000).toISOString() }) }));
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['STRIPE_PRICE_PLUS_MONTHLY', 'plus'], ['STRIPE_PRICE_PLUS_ANNUAL', 'plus_annual'],
    ['STRIPE_PRICE_BASIC_MONTHLY', 'basic'], ['STRIPE_PRICE_BASIC_ANNUAL', 'basic_annual'],
    ['STRIPE_PRICE_FAMILY_MONTHLY', 'basic'], ['STRIPE_PRICE_FAMILY_ANNUAL', 'basic_annual'],
  ])('retains custom environment-configured price mapping for %s', async (key, slug) => {
    vi.stubEnv(key, 'price_custom_annual');
    expect((await webhook(event('price_custom_annual'))).status).toBe(200);
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', value: expect.objectContaining({ plan: slug, current_period_end: new Date(1_900_000_000_000).toISOString() }) }));
  });
  it('rejects an unknown price without writing a free or incorrect subscription', async () => {
    expect((await webhook(event('price_unknown'))).status).toBe(500);
    expect(mocks.writes).toEqual([]); expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.markError).toHaveBeenCalledTimes(1);
  });
});

describe('subscription webhook item periods', () => {
  const basic = PRICES.stripePrices.basic_monthly.id;
  const plus = PRICES.stripePrices.plus_annual.id;
  const period = 1_900_000_000;
  const isoPeriod = new Date(period * 1000).toISOString();
  const subscription = (items: unknown[] = [subscriptionItem(basic)]) => ({
    id: 'sub-existing', metadata: { family_id: 'family-a' }, customer: 'cus-fixture',
    status: 'active', cancel_at_period_end: false, items: { data: items, has_more: false },
  });
  const delivery = () => new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}' });
  function setup(current: Record<string, unknown>, type = 'customer.subscription.updated', payload = current) {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
    mocks.constructEvent.mockReturnValue({ id: 'evt-period', type, data: { object: payload } });
    mocks.retrieveSubscription.mockResolvedValue(current);
  }
  function expectPeriodWrite(plan = 'basic', currentPeriodEnd = isoPeriod) {
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', operation: 'update',
      value: expect.objectContaining({ plan, current_period_end: currentPeriodEnd }) }));
  }
  async function expectRetryableFailure() {
    const response = await webhook(delivery());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'stripe.handlerFailed' });
    expect(mocks.writes).toEqual([]);
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.markError).toHaveBeenCalledWith(expect.anything(), 'evt-period', expect.any(String), 'claim-fixture');
  }

  it.each(['created', 'updated', 'deleted'])('persists the item period for subscription.%s', async lifecycle => {
    const current = { ...subscription(), status: lifecycle === 'deleted' ? 'canceled' : 'active' };
    if (lifecycle === 'created') mocks.rows.subscriptions = null;
    setup(current, `customer.subscription.${lifecycle}`);
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite();
    const writes = mocks.writes.filter(w => w.table === 'subscriptions');
    expect(writes.map(w => w.operation)).toEqual(lifecycle === 'created' ? ['update', 'insert'] : ['update']);
    for (const write of writes) expect(write.value).toMatchObject({ status: current.status, current_period_end: isoPeriod });
    expect(mocks.markProcessed).toHaveBeenCalledWith(expect.anything(), 'evt-period', 'claim-fixture');
    expect(mocks.markError).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('uses the unique mapped item at index %i, ignoring unrelated earlier/later periods', async index => {
    const items = [subscriptionItem('price_addon_early', period - 10_000), subscriptionItem('price_addon_late', period + 10_000)];
    items.splice(index, 0, subscriptionItem(plus, period));
    setup({ ...subscription(items), current_period_end: period + 99_000 });
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite('plus_annual');
  });

  it.each([
    ['two different plans', [subscriptionItem(basic), subscriptionItem(plus)]],
    ['the same mapped price twice', [subscriptionItem(basic), subscriptionItem(basic, period + 10_000)]],
    ['no recognized plan', [subscriptionItem('price_unrelated')]],
    ['no items', []],
    ['an item without a price', [{}]],
    ['a malformed extra item', [subscriptionItem(basic), null]],
    ['a malformed extra price ID', [subscriptionItem(basic), { price: { id: 123 } }]],
  ])('retries %s without granting or changing entitlement', async (_label, items) => {
    setup(subscription(items as unknown[]));
    await expectRetryableFailure();
  });

  it('does not infer uniqueness from a partial item list', async () => {
    const current = subscription();
    setup({ ...current, items: { ...current.items, has_more: true } });
    await expectRetryableFailure();
  });

  it.each([undefined, null, {}, { data: null }])('retries malformed item collection %j', async items => {
    setup({ ...subscription(), items });
    await expectRetryableFailure();
  });

  it.each([undefined, null, '1900000000', NaN, Infinity, -Infinity, 0, -1, period + 0.5, Number.MAX_SAFE_INTEGER + 1, 8_640_000_000_001])(
    'retries an invalid mapped item period %s even with other valid periods', async invalid => {
      setup({ ...subscription([
        subscriptionItem('price_addon'), { ...subscriptionItem(basic), current_period_end: invalid },
      ]), current_period_end: period });
      await expectRetryableFailure();
    },
  );

  it('accepts a past item period when recording a cancellation', async () => {
    setup({ ...subscription([subscriptionItem(basic, 1_600_000_000)]), status: 'canceled' }, 'customer.subscription.deleted');
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite('basic', new Date(1_600_000_000_000).toISOString());
  });

  it('writes both the plan and period from retrieval when the delivered event is stale', async () => {
    setup(subscription([subscriptionItem(plus, period + 10_000)]), 'customer.subscription.updated', subscription());
    expect((await webhook(delivery())).status).toBe(200);
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith('sub-existing');
    expectPeriodWrite('plus_annual', new Date((period + 10_000) * 1000).toISOString());
  });

  it('reprocesses a failed period delivery using the newly retrieved item', async () => {
    setup(subscription([{ ...subscriptionItem(basic), current_period_end: undefined }]));
    await expectRetryableFailure();
    mocks.retrieveSubscription.mockResolvedValue(subscription());
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite();
    expect(mocks.retrieveSubscription).toHaveBeenCalledTimes(2);
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it.each(['returned', 'thrown'] as const)('retries a %s persistence failure with the same valid item period', async failure => {
    setup(subscription());
    mocks.syncFailure = failure;
    expect((await webhook(delivery())).status).toBe(500);
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.markError).toHaveBeenCalledTimes(1);
    mocks.syncFailure = 'none';
    mocks.writes = [];
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite();
  });

  it('returns 503 on failed finalization and safely persists the retrieved period on retry', async () => {
    setup(subscription());
    mocks.markProcessed.mockRejectedValueOnce(new Error('finalization unavailable'));
    expect((await webhook(delivery())).status).toBe(503);
    expectPeriodWrite();
    mocks.writes = [];
    expect((await webhook(delivery())).status).toBe(200);
    expectPeriodWrite();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(2);
    expect(mocks.markError).not.toHaveBeenCalled();
  });

  it.each([['duplicate', 200], ['in_flight', 409]] as const)('does not retrieve or write an already %s delivery', async (outcome, status) => {
    setup(subscription());
    mocks.recordEvent.mockResolvedValue({ outcome });
    expect((await webhook(delivery())).status).toBe(status);
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.markError).not.toHaveBeenCalled();
  });
});

// PAY-DOUBLE-001: Checkout starts a subscription; it never starts a second one.
describe('Checkout refuses a family that already has a live subscription', () => {
  it.each(['active', 'trialing', 'past_due'])('refuses a local %s subscription and sends the parent to the billing review', async status => {
    mocks.rows.subscriptions = { plan: 'basic', status, provider_ref: 'sub-existing' };
    const response = await checkout(request('plus_monthly'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'subscription_exists', review: '/dashboard/billing?view=manage&reviewPlan=plus_monthly' });
    noPaidMutation();
  });

  it('asks Stripe when the local row has not caught up with a subscription the customer already has', async () => {
    mocks.rows.subscriptions = { plan: 'free', status: 'active', provider_ref: null };
    mocks.rows.billing_customers = { customer_ref: 'cus-existing' };
    mocks.listSubscriptions.mockResolvedValue({ data: [{ id: 'sub-just-paid', status: 'active' }] });
    const response = await checkout(request('family_annual'));
    expect(response.status).toBe(409);
    expect(mocks.listSubscriptions).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus-existing' }));
    expect(await response.json()).toMatchObject({ review: '/dashboard/billing?view=manage&reviewPlan=basic_annual' });
    noPaidMutation();
  });

  it('starts Checkout for a returning customer whose only subscription ended', async () => {
    mocks.rows.subscriptions = { plan: 'basic', status: 'canceled', provider_ref: 'sub-old' };
    mocks.rows.billing_customers = { customer_ref: 'cus-existing' };
    mocks.listSubscriptions.mockResolvedValue({ data: [{ id: 'sub-old', status: 'canceled' }, { id: 'sub-older', status: 'incomplete_expired' }] });
    expect((await checkout(request('basic_annual'))).status).toBe(200);
    expect(mocks.createCheckout).toHaveBeenCalledTimes(1);
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });

  it('answers unavailable, not a new subscription, when the subscription read fails', async () => {
    mocks.errors.subscriptions = { message: 'private read failure' };
    expect((await checkout(request('basic_annual'))).status).toBe(503);
    noPaidMutation();
  });
});

describe('an ended subscription does not overwrite a different live one (PAY-DOUBLE-001)', () => {
  function ended(status: string, id = 'sub-old') {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
    const subscription = {
      id, metadata: { family_id: 'family-a' }, customer: 'cus-fixture', items: { data: [subscriptionItem(PRICES.stripePrices.basic_monthly.id)], has_more: false },
      status, cancel_at_period_end: false,
    };
    mocks.constructEvent.mockReturnValue({ id: `evt-${status}`, type: 'customer.subscription.deleted', data: { object: subscription } });
    mocks.retrieveSubscription.mockResolvedValue(subscription);
    return new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}' });
  }
  it.each(['canceled', 'incomplete_expired', 'unpaid'])('keeps the live row when another subscription reports %s', async status => {
    // The row records sub-existing as active (the suite default).
    const response = await webhook(ended(status));
    expect(response.status).toBe(200);
    expect(mocks.writes.filter(w => w.table === 'subscriptions')).toEqual([]);
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });
  it('still records the end of the subscription the row holds', async () => {
    expect((await webhook(ended('canceled', 'sub-existing'))).status).toBe(200);
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: 'subscriptions', operation: 'update', value: expect.objectContaining({ status: 'canceled', provider_ref: 'sub-existing' }) }));
  });
});

// PAY-ORDER-001: Stripe does not deliver events in order, and each carries the
// subscription as it was when that event was created. The webhook writes the
// subscription's state NOW, read from Stripe, so a stale event cannot land last.
describe('a subscription event arriving out of order does not undo a newer state (PAY-ORDER-001)', () => {
  const basic = PRICES.stripePrices.basic_monthly.id;
  function stale(object: Record<string, unknown>) {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
    mocks.constructEvent.mockReturnValue({ id: 'evt-stale', type: 'customer.subscription.updated', data: { object } });
    return new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}' });
  }
  const sub = (status: string) => ({
    id: 'sub-existing', metadata: { family_id: 'family-a' }, customer: 'cus-fixture', items: { data: [subscriptionItem(basic)], has_more: false },
    status, cancel_at_period_end: false,
  });

  it('records the canceled state Stripe holds, not the older active payload', async () => {
    mocks.retrieveSubscription.mockResolvedValue(sub('canceled'));
    const response = await webhook(stale(sub('active')));
    expect(response.status).toBe(200);
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith('sub-existing');
    const written = mocks.writes.filter(w => w.table === 'subscriptions');
    expect(written).toContainEqual(expect.objectContaining({ operation: 'update', value: expect.objectContaining({ status: 'canceled' }) }));
    expect(written).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ status: 'active' }) }));
  });

  it('without a secret key, refuses to write the payload and asks Stripe to retry', async () => {
    mocks.secretKey = null;
    const response = await webhook(stale(sub('active')));
    expect(response.status).toBe(500);
    expect(mocks.writes).toEqual([]);
    expect(mocks.markError).toHaveBeenCalledTimes(1);
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('a failed Stripe read is retried, not written from the payload', async () => {
    mocks.retrieveSubscription.mockRejectedValue(new Error('stripe unavailable'));
    expect((await webhook(stale(sub('active')))).status).toBe(500);
    expect(mocks.writes).toEqual([]);
  });

  it('does not call Stripe for an event that names no family (control)', async () => {
    const response = await webhook(stale({ ...sub('active'), metadata: {} }));
    expect(response.status).toBe(200);
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });
});
