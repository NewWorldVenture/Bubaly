// The billing routes and the Stripe webhook, driven through their real code with
// an in-memory database and a scripted Stripe. Each block is a negative control
// for one audited failure: it fails on the code before the fix.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PRICES from '@/lib/constants/family-prices.json';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  writes: [] as { table: string; operation: string; value: unknown; filters: [string, unknown][] }[],
  stepUp: false,
  stripeSubs: {} as Record<string, Row>,
  listed: [] as Row[],
  sessions: {} as Record<string, Row>,
  created: [] as { params: Row; options: Row | undefined }[],
  expired: [] as string[],
  updatedSubs: [] as { id: string; params: Row }[],
  portalOpened: 0,
  event: null as unknown,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = () => ({ user: { id: 'user-a', email: 'parent@example.test' },
    active: { role: 'parent', familyId: 'family-a', family: { name: 'Fixture family' } }, memberships: [] });
  return { requireUserContext: async () => ctx(), getUserContext: async () => ctx() };
});
vi.mock('@/lib/auth/require-aal2', () => ({
  aal2Verdict: async () => (h.stepUp
    ? { action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Fbilling', reason: 'needs_code' }
    : { action: 'allow' }),
}));
vi.mock('@/lib/supabase/server', () => {
  // A small PostgREST: eq/in filters, maybeSingle's "more than one row" error,
  // order/limit lists, and update/insert/upsert that land in `h.tables`.
  function query(table: string) {
    const filters: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    let op: { kind: 'update'; value: Row } | null = null;
    const matching = () => (h.tables[table] ?? []).filter(row =>
      filters.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c])));
    const settleList = () => {
      if (op) {
        const rows = matching();
        for (const row of rows) Object.assign(row, op.value);
        h.writes.push({ table, operation: 'update', value: op.value, filters: [...filters] });
        return { data: rows.map(r => ({ id: r.id })), error: null };
      }
      return { data: matching().map(r => ({ ...r })), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return builder; },
      in: (c: string, vs: unknown[]) => { ins.push([c, vs]); return builder; },
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        const rows = matching();
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: rows[0] ? { ...rows[0] } : null, error: null };
      },
      update: (value: Row) => { op = { kind: 'update', value }; return builder; },
      insert: async (value: Row) => {
        h.writes.push({ table, operation: 'insert', value, filters: [] });
        (h.tables[table] ??= []).push({ ...value });
        return { error: null };
      },
      upsert: (value: Row) => {
        h.writes.push({ table, operation: 'upsert', value, filters: [] });
        const chain = { select: () => chain, maybeSingle: async () => ({ data: { ...value }, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(settleList()).then(resolve, reject),
    };
    return builder;
  }
  const db = { from: query };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/stripe', async () => {
  const { default: prices } = await import('@/lib/constants/family-prices.json');
  const price = (id: string) => {
    const plan = Object.entries(prices.stripePrices).find(([, e]) => e.id === id)?.[0] ?? 'basic_annual';
    const annual = plan.endsWith('_annual'); const tier = plan.startsWith('plus') ? prices.plus : prices.basic;
    return { id, active: true, type: 'recurring', currency: 'usd', unit_amount: annual ? tier.annualCents : tier.monthlyCents,
      billing_scheme: 'per_unit', transform_quantity: null, custom_unit_amount: null,
      recurring: { interval: annual ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' } };
  };
  let n = 0;
  const stripe = {
    prices: { retrieve: async (id: string) => price(id) },
    customers: { create: async () => ({ id: 'cus-new' }) },
    subscriptions: {
      list: async () => ({ data: h.listed }),
      retrieve: async (id: string) => {
        const sub = h.stripeSubs[id];
        if (!sub) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
        return sub;
      },
      update: async (id: string, params: Row) => { h.updatedSubs.push({ id, params }); return {}; },
    },
    checkout: { sessions: {
      create: async (params: Row, options?: Row) => {
        h.created.push({ params, options });
        const id = `cs-${++n}`;
        h.sessions[id] = { id, status: 'open', url: `https://checkout.example.test/${id}` };
        return h.sessions[id];
      },
      retrieve: async (id: string) => h.sessions[id],
      expire: async (id: string) => { h.expired.push(id); h.sessions[id] = { ...h.sessions[id], status: 'expired' }; return h.sessions[id]; },
    } },
    billingPortal: { sessions: { create: async () => { h.portalOpened++; return { url: 'https://portal.example.test' }; } } },
  };
  return { stripeFromKey: () => stripe, getStripe: () => stripe, constructWebhookEvent: () => h.event, STRIPE_PLANS: {
    basic_monthly: prices.stripePrices.basic_monthly.id, basic_annual: prices.stripePrices.basic_annual.id,
    plus_monthly: prices.stripePrices.plus_monthly.id, plus_annual: prices.stripePrices.plus_annual.id,
    family_monthly: prices.stripePrices.basic_monthly.id, family_annual: prices.stripePrices.basic_annual.id,
  } };
});
// The service fee is configured ON, so whether a Checkout carries it is visible.
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => ({ enabled: true, service_fee_cents: 90, service_fee_price_id: 'price_service_fee' }),
  effectiveSecretKey: () => 'sk_test_fixture',
  effectiveWebhookSecret: () => 'whsec_fixture',
}));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/stripe/webhook', () => ({
  recordEvent: async () => ({ outcome: 'claimed', claimToken: 'claim' }), markEventProcessed: async () => {}, markEventError: async () => {},
}));
vi.mock('@/lib/referrals/server', () => ({ markReferralConverted: async () => {}, rewardConvertedReferral: async () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));

import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as changePlan } from '@/app/api/billing/change-plan/route';
import { POST as cancel } from '@/app/api/billing/cancel/route';
import { POST as portal } from '@/app/api/billing/portal/route';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';

const PLUS = PRICES.stripePrices.plus_monthly.id;
const post = (path: string, body: unknown = {}) => new NextRequest(`https://app.example.test${path}`, { method: 'POST', body: JSON.stringify(body) });
const delivery = (type: string, sub: Row) => {
  h.event = { id: `evt-${type}`, type, data: { object: sub } };
  return new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'sig' } });
};
const stripeSub = (id: string, status: string, priceId: string) => ({
  id, status, cancel_at_period_end: false, customer: 'cus-a', metadata: { family_id: 'family-a' },
  items: { has_more: false, data: [{ id: `si-${id}`, price: { id: priceId }, current_period_end: 1_900_000_000 }] },
});
const subscriptionRows = () => h.tables.subscriptions ?? [];
const subscriptionWrites = () => h.writes.filter(w => w.table === 'subscriptions');
const alerts = () => h.writes.filter(w => w.table === 'admin_notifications');

beforeEach(() => {
  h.tables = { subscriptions: [], billing_customers: [], checkout_sessions: [] };
  h.writes = []; h.stepUp = false; h.stripeSubs = {}; h.listed = []; h.sessions = {};
  h.created = []; h.expired = []; h.updatedSubs = []; h.portalOpened = 0; h.event = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the billing API routes ask for the same step-up their page does', () => {
  beforeEach(() => {
    h.stepUp = true;
    h.tables.billing_customers = [{ family_id: 'family-a', customer_ref: 'cus-a' }];
    h.tables.subscriptions = [{ id: 's1', family_id: 'family-a', plan: 'basic', status: 'active', provider_ref: 'sub-a', cancel_at_period_end: false }];
    h.stripeSubs['sub-a'] = stripeSub('sub-a', 'active', PRICES.stripePrices.basic_monthly.id);
  });
  it.each([
    ['portal', () => portal(post('/api/billing/portal'))],
    ['cancel', () => cancel(post('/api/billing/cancel', { resume: false }))],
    ['change-plan', () => changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }))],
    ['checkout', () => checkout(post('/api/billing/checkout', { plan: 'plus_monthly' }))],
  ])('%s refuses an aal1 session with the step-up path and touches nothing in Stripe', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'step_up_required', stepUp: '/auth/step-up?next=%2Fdashboard%2Fbilling' });
    expect(h.portalOpened).toBe(0);
    expect(h.updatedSubs).toEqual([]);
    expect(h.created).toEqual([]);
  });
});

describe('change-plan asks Stripe before starting a second subscription', () => {
  it('refuses Checkout when the local row trails a subscription Stripe already holds', async () => {
    // The row still shows the seeded trial; checkout has just completed in Stripe.
    h.tables.subscriptions = [{ id: 's1', family_id: 'family-a', plan: 'free', status: 'trialing', provider_ref: null, cancel_at_period_end: false }];
    h.tables.billing_customers = [{ family_id: 'family-a', customer_ref: 'cus-a' }];
    h.listed = [{ id: 'sub-just-paid', status: 'active' }];
    const response = await changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'subscription_exists' });
    expect(h.created).toEqual([]);
  });

  it('still starts Checkout for a returning customer whose subscriptions all ended', async () => {
    h.tables.billing_customers = [{ family_id: 'family-a', customer_ref: 'cus-a' }];
    h.listed = [{ id: 'sub-old', status: 'canceled' }];
    const response = await changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }));
    expect(response.status).toBe(200);
    expect(h.created).toHaveLength(1);
  });
});

describe('a Checkout started from change-plan carries the service fee', () => {
  it('adds the configured fee exactly as checkout does', async () => {
    expect((await changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }))).status).toBe(200);
    expect((await checkout(post('/api/billing/checkout', { plan: 'basic_monthly' }))).status).toBe(200);
    expect(h.created).toHaveLength(2);
    for (const { params } of h.created) {
      expect(params.subscription_data).toMatchObject({ add_invoice_items: [{ price: 'price_service_fee', quantity: 1 }] });
    }
  });
});

describe('a family cannot hold two payable Checkout Sessions', () => {
  it('returns the open session for the same plan instead of creating another', async () => {
    const first = await (await checkout(post('/api/billing/checkout', { plan: 'plus_monthly' }))).json();
    const second = await (await checkout(post('/api/billing/checkout', { plan: 'plus_monthly' }))).json();
    expect(h.created).toHaveLength(1);
    expect(second.url).toBe(first.url);
  });

  it('expires the open session for another plan before creating the new one', async () => {
    await checkout(post('/api/billing/checkout', { plan: 'basic_monthly' }));
    const basicSession = h.tables.checkout_sessions[0].session_id;
    await changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }));
    expect(h.created).toHaveLength(2);
    expect(h.expired).toEqual([basicSession]);
  });

  it('gives concurrent creates the same idempotency key', async () => {
    // Neither request has seen the other's tracking row yet.
    await Promise.all([
      checkout(post('/api/billing/checkout', { plan: 'plus_monthly' })),
      checkout(post('/api/billing/checkout', { plan: 'plus_monthly' })),
    ]);
    const keys = h.created.map(c => c.options?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(typeof keys[0]).toBe('string');
    expect(keys[1]).toBe(keys[0]);
  });

  it('does not let a second live subscription overwrite the one the row records', async () => {
    h.tables.subscriptions = [{ id: 's1', family_id: 'family-a', plan: 'basic', status: 'active', provider_ref: 'sub-first', cancel_at_period_end: false }];
    h.stripeSubs['sub-first'] = stripeSub('sub-first', 'active', PRICES.stripePrices.basic_monthly.id);
    h.stripeSubs['sub-second'] = stripeSub('sub-second', 'active', PLUS);
    const response = await webhook(delivery('customer.subscription.created', h.stripeSubs['sub-second']));
    expect(response.status).toBe(200);
    expect(subscriptionWrites()).toEqual([]);
    expect(subscriptionRows()[0]).toMatchObject({ provider_ref: 'sub-first', plan: 'basic' });
    expect(alerts()).toHaveLength(1);
  });

  it('still records a resubscription once the recorded subscription has ended in Stripe', async () => {
    h.tables.subscriptions = [{ id: 's1', family_id: 'family-a', plan: 'basic', status: 'active', provider_ref: 'sub-first', cancel_at_period_end: false }];
    h.stripeSubs['sub-first'] = stripeSub('sub-first', 'canceled', PRICES.stripePrices.basic_monthly.id);
    h.stripeSubs['sub-second'] = stripeSub('sub-second', 'active', PLUS);
    expect((await webhook(delivery('customer.subscription.created', h.stripeSubs['sub-second']))).status).toBe(200);
    expect(subscriptionRows()[0]).toMatchObject({ provider_ref: 'sub-second', plan: 'plus', status: 'active' });
  });
});

describe('a cancellation on an unrecognized price still lands', () => {
  beforeEach(() => {
    h.tables.subscriptions = [{ id: 's1', family_id: 'family-a', plan: 'plus', status: 'active', provider_ref: 'sub-x', cancel_at_period_end: false }];
  });

  it('writes the ended status and keeps the stored plan', async () => {
    h.stripeSubs['sub-x'] = stripeSub('sub-x', 'canceled', 'price_retired_without_previous_id');
    const response = await webhook(delivery('customer.subscription.deleted', h.stripeSubs['sub-x']));
    expect(response.status).toBe(200);
    expect(subscriptionRows()[0]).toMatchObject({ plan: 'plus', status: 'canceled', provider_ref: 'sub-x' });
    expect(alerts()).toHaveLength(1);
  });

  it('still refuses (and retries) an unknown price that would grant access', async () => {
    h.stripeSubs['sub-x'] = stripeSub('sub-x', 'active', 'price_retired_without_previous_id');
    const response = await webhook(delivery('customer.subscription.updated', h.stripeSubs['sub-x']));
    expect(response.status).toBe(500);
    expect(subscriptionWrites()).toEqual([]);
    expect(subscriptionRows()[0]).toMatchObject({ plan: 'plus', status: 'active' });
  });

  it('ignores an ended unknown-price subscription the row does not record', async () => {
    h.stripeSubs['sub-other'] = stripeSub('sub-other', 'canceled', 'price_retired_without_previous_id');
    expect((await webhook(delivery('customer.subscription.deleted', h.stripeSubs['sub-other']))).status).toBe(200);
    expect(subscriptionWrites()).toEqual([]);
  });
});

describe('a family with more than one subscriptions row', () => {
  beforeEach(() => {
    h.tables.subscriptions = [
      { id: 'seed', family_id: 'family-a', plan: 'free', status: 'trialing', provider_ref: null, cancel_at_period_end: false },
      { id: 'paid', family_id: 'family-a', plan: 'plus', status: 'active', provider_ref: 'sub-x', cancel_at_period_end: false },
    ];
    h.tables.billing_customers = [{ family_id: 'family-a', customer_ref: 'cus-a' }];
  });

  it('records a cancellation from the webhook instead of failing every retry', async () => {
    h.stripeSubs['sub-x'] = stripeSub('sub-x', 'canceled', PLUS);
    expect((await webhook(delivery('customer.subscription.deleted', h.stripeSubs['sub-x']))).status).toBe(200);
    expect(subscriptionRows().find(r => r.id === 'paid')).toMatchObject({ status: 'canceled' });
  });

  it('lets the parent schedule a cancellation of the live subscription', async () => {
    const response = await cancel(post('/api/billing/cancel', { resume: false }));
    expect(response.status).toBe(200);
    expect(h.updatedSubs).toEqual([{ id: 'sub-x', params: { cancel_at_period_end: true } }]);
  });

  it('changes the live subscription in place, and checkout refuses a second one', async () => {
    h.stripeSubs['sub-x'] = stripeSub('sub-x', 'active', PLUS);
    (h.stripeSubs['sub-x'].items as { data: Row[] }).data[0].price = { id: PRICES.stripePrices.basic_monthly.id };
    expect((await changePlan(post('/api/billing/change-plan', { plan: 'plus_monthly' }))).status).toBe(200);
    expect(h.updatedSubs.map(u => u.id)).toEqual(['sub-x']);
    expect((await checkout(post('/api/billing/checkout', { plan: 'plus_monthly' }))).status).toBe(409);
    expect(h.created).toEqual([]);
  });
});
