import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Found by the API sweep (scripts/api-audit). Super Admin → Stripe Setup saves a
// secret key and a webhook signing secret to `stripe_settings`, and promises
// "configured value first, then env" (lib/stripe/settings.ts). Only checkout
// kept that promise:
//
//  - portal, cancel and change-plan built their client with getStripe(), which
//    reads STRIPE_SECRET_KEY alone. A family that subscribed through the
//    configured key could not open the portal, cancel, or change plan.
//  - the Stripe webhook read STRIPE_WEBHOOK_SECRET alone, and built a client
//    with getStripe() just to check the signature. With the key unset that
//    threw, and the catch answered "signature invalid": every real event
//    refused, so no subscription was ever recorded.
//  - with no key anywhere, every billing route answered a generic 500.
//
// Real Stripe signature verification below, no mock of it: the signed payload
// is made with Stripe's own test-header generator.

// A configured price, so checkout reaches the key check (STRIPE_PLANS is read
// from the environment when lib/stripe first loads).
vi.hoisted(() => { process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_fixture_basic_monthly'; });

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string | null>,
  keysUsed: [] as string[],
  portal: vi.fn(async () => ({ url: 'https://billing.stripe.test/session' })),
  update: vi.fn(async () => ({})),
  recordEvent: vi.fn(async () => ({ outcome: 'duplicate' })),
}));

// The billing routes now ask for the AAL2 step-up (/dashboard/billing's own
// guard); these cases are about what they do once the session has it.
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: vi.fn(async () => ({
    user: { id: 'user-a', email: 'fixture@example.test' },
    active: { role: 'parent', familyId: 'family-a', family: { name: 'Fixture family' } },
  })),
}));
vi.mock('@/lib/supabase/server', () => {
  const rows: Record<string, unknown> = {
    billing_customers: { customer_ref: 'cus_fixture' },
    subscriptions: { provider_ref: 'sub_fixture', status: 'active' },
  };
  const db = { from: (table: string) => {
    const b = { select: () => b, eq: () => b, update: () => b,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'x' }], error: null }) };
    return b;
  } };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/stripe/settings', async () => {
  const real = await vi.importActual<typeof import('@/lib/stripe/settings')>('@/lib/stripe/settings');
  return { ...real, getStripeSettings: async () => mocks.settings };
});
vi.mock('@/lib/stripe', async () => {
  const real = await vi.importActual<typeof import('@/lib/stripe')>('@/lib/stripe');
  return {
    ...real,
    getStripe: () => { throw new Error('getStripe() reads only STRIPE_SECRET_KEY; billing routes must not use it'); },
    stripeFromKey: (key: string) => {
      mocks.keysUsed.push(key);
      return { billingPortal: { sessions: { create: mocks.portal } }, subscriptions: { update: mocks.update } };
    },
  };
});
vi.mock('@/lib/stripe/webhook', () => ({ recordEvent: mocks.recordEvent, markEventProcessed: vi.fn(), markEventError: vi.fn() }));

const saved = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_WEBHOOK_SECRET };
beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  mocks.settings = {};
  mocks.keysUsed = [];
  vi.clearAllMocks();
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  if (saved.hook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved.hook;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`https://www.bubaly.com${path}`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('billing routes use the Stripe key Super Admin → Stripe Setup saved', () => {
  it('opens the portal with the configured key when the environment has none', async () => {
    mocks.settings = { secret_key: 'sk_test_from_admin' };
    const { POST } = await import('@/app/api/billing/portal/route');
    const res = await POST(post('/api/billing/portal', {}));
    expect(res.status).toBe(200);
    expect(mocks.keysUsed).toEqual(['sk_test_from_admin']);
    expect(mocks.portal).toHaveBeenCalledTimes(1);
  });

  it('cancels with the configured key when the environment has none', async () => {
    mocks.settings = { secret_key: 'sk_test_from_admin' };
    const { POST } = await import('@/app/api/billing/cancel/route');
    const res = await POST(post('/api/billing/cancel', { resume: false }));
    expect(mocks.keysUsed).toEqual(['sk_test_from_admin']);
    expect(mocks.update).toHaveBeenCalledWith('sub_fixture', { cancel_at_period_end: true });
    expect(res.status).toBeLessThan(500);
  });

  it.each([
    ['portal', '/api/billing/portal', {}],
    ['cancel', '/api/billing/cancel', { resume: false }],
    ['checkout', '/api/billing/checkout', { plan: 'basic_monthly' }],
  ])('%s says billing is not set up, with no Stripe call, when no key exists anywhere', async (name, path, body) => {
    const { POST } = await import(`@/app/api/billing/${name}/route`);
    const res = await POST(post(path, body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'checkout.billingIsNotSetUp' });
    expect(mocks.keysUsed).toEqual([]);
  });

  it('checkout reads the body before anything else: a malformed one is a 400, not a 500', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(post('/api/billing/checkout', '{"unterminated'));
    expect(res.status).toBe(400);
  });
});

describe('the Stripe webhook verifies with the configured signing secret', () => {
  const payload = JSON.stringify({ id: 'evt_fixture', object: 'event', type: 'customer.subscription.updated', data: { object: {} } });
  const signed = (secret: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret });

  it('accepts an event signed with the secret saved in Stripe Setup, with no Stripe env at all', async () => {
    mocks.settings = { webhook_secret: 'whsec_from_admin' };
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(post('/api/webhooks/stripe', payload, { 'stripe-signature': signed('whsec_from_admin') }));
    expect(res.status).toBe(200);
    expect(mocks.recordEvent).toHaveBeenCalledTimes(1);
  });

  it('still refuses an event signed with any other secret', async () => {
    mocks.settings = { webhook_secret: 'whsec_from_admin' };
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(post('/api/webhooks/stripe', payload, { 'stripe-signature': signed('whsec_someone_else') }));
    expect(res.status).toBe(400);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it('falls back to STRIPE_WEBHOOK_SECRET when Stripe Setup holds none', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_from_env';
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(post('/api/webhooks/stripe', payload, { 'stripe-signature': signed('whsec_from_env') }));
    expect(res.status).toBe(200);
  });

  it('is "not configured" with no secret anywhere', async () => {
    const { POST } = await import('@/app/api/webhooks/stripe/route');
    const res = await POST(post('/api/webhooks/stripe', payload, { 'stripe-signature': signed('whsec_x') }));
    expect(res.status).toBe(503);
  });
});
