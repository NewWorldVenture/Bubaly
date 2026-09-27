import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Found by the API sweep of every route on a local production build, signed
// in as a parent: POST /api/billing/checkout and /api/billing/portal answered
// 500 ("Could not create checkout session" / "Could not open billing portal")
// wherever Stripe had no secret key, because the Stripe client was built
// before anything else and its "STRIPE_SECRET_KEY is not set" landed in the
// catch-all. Checkout built it even before reading the request, so a
// malformed body was a 500 too.
//
// A missing key is the service being unavailable, which these routes already
// answer as 503 when Stripe's price or the billing record cannot be read; a
// body that is not a plan is the caller's error, 400, whatever is configured.
// Changing or cancelling a plan, which read their body first and so answered
// the sweep's malformed one with 400, turned a well-formed request into the
// same 500; they are held to the same answer here.

const state = vi.hoisted(() => ({ stripeBuilt: 0 }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  getUserContext: async () => null,
  requireUserContext: async () => ({
    user: { id: 'u1', email: 'parent@example.test' },
    active: { familyId: 'f1', role: 'parent', family: { name: 'Fixture' } },
  }),
}));
// One row serves both reads: the family's Stripe customer (checkout, portal)
// and its live subscription (cancel).
const row = { customer_ref: 'cus_1', provider_ref: 'sub_1', status: 'active' };
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  }),
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/stripe', () => ({
  STRIPE_PLANS: { basic_monthly: 'price_basic_monthly' },
  getStripe: () => { state.stripeBuilt++; throw new Error('STRIPE_SECRET_KEY is not set'); },
  stripeFromKey: () => { state.stripeBuilt++; throw new Error('STRIPE_SECRET_KEY is not set'); },
}));
vi.mock('@/lib/billing/price-catalog', () => ({
  canonicalStripePlan: (k: unknown) => k,
  isStripePlanKey: (k: unknown) => k === 'basic_monthly',
  verifyStripePlanPrice: async () => true,
}));
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => null, effectiveSecretKey: () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

function post(path: string, body: string) {
  return new NextRequest(`https://www.bubaly.com${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  state.stripeBuilt = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('billing where Stripe is not configured', () => {
  it('Checkout answers a malformed body with 400, before building a Stripe client', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(post('/api/billing/checkout', '{"plan":'));
    expect(res.status).toBe(400);
    expect(state.stripeBuilt).toBe(0);
  });

  it('Checkout answers a plan it does not know with 400, before building a Stripe client', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(post('/api/billing/checkout', '{"plan":"gold_forever"}'));
    expect(res.status).toBe(400);
    expect(state.stripeBuilt).toBe(0);
  });

  it('Checkout answers a valid plan with 503 "temporarily unavailable", not 500', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(post('/api/billing/checkout', '{"plan":"basic_monthly"}'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('checkout.billingAccountStatusIsTemporarily');
  });

  it('the billing portal answers 503 "temporarily unavailable", not 500', async () => {
    const { POST } = await import('@/app/api/billing/portal/route');
    const res = await POST(post('/api/billing/portal', '{}'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('portal.billingAccountStatusIsTemporarily');
  });

  it('changing plan answers 503 "temporarily unavailable", not 500', async () => {
    const { POST } = await import('@/app/api/billing/change-plan/route');
    const res = await POST(post('/api/billing/change-plan', '{"plan":"basic_monthly"}'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('changePlan.subscriptionStatusIsTemporarilyUnavailable');
  });

  it('cancelling answers 503 "temporarily unavailable", not 500', async () => {
    const { POST } = await import('@/app/api/billing/cancel/route');
    const res = await POST(post('/api/billing/cancel', '{"resume":false}'));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('cancel.subscriptionStatusIsTemporarilyUnavailable');
  });
});
