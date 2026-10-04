// A family pays for one subscription.
//
// A paid Checkout Session in `subscription` mode creates a NEW subscription,
// whatever the customer already has. Two paths could still start one for a
// family that already pays:
//
//  1. The billing page's plan buttons (and its `?checkout=` auto-checkout) go
//     through /api/billing/change-plan. When the family's `subscriptions` row is
//     not live, that route went straight to Checkout. PAY-DOUBLE-001 taught
//     /api/billing/checkout to ask Stripe in that case, because the row lags
//     the subscription by a webhook, but not this route. A parent who pays,
//     lands back on a page the webhook has not reached yet, and picks a plan
//     again, was charged for a second subscription.
//  2. A Checkout Session stays payable for 24 hours. Opening a second one (a
//     second tab, or back to the billing page and choose again) left the first
//     payable, so paying both created two subscriptions.
//
// Stripe is a small in-memory fake: sessions with a status, and the customer's
// subscriptions. No network, no keys, synthetic ids only.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as checkout } from '@/app/api/billing/checkout/route';
import { POST as changePlan } from '@/app/api/billing/change-plan/route';
import { checkNewSubscription } from '@/lib/billing/one-subscription';

type Session = { id: string; mode: string; status: 'open' | 'complete' | 'expired'; customer: string };

const fake = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown> | null>,
  sessions: [] as { id: string; mode: string; status: 'open' | 'complete' | 'expired'; customer: string }[],
  subscriptions: [] as { id: string; status: string }[],
  subscriptionsHaveMore: false,
  sessionsHaveMore: false,
  trace: [] as string[],
  created: 0,
  // What `expire` does to a session before refusing; `null` is a plain success.
  onExpire: null as null | ((session: { status: string }) => void),
  listSubscriptionsFails: false,
  // Runs just after Stripe has answered a subscriptions listing: what happens in
  // the world between that answer and our next call.
  afterSubscriptionsList: null as null | (() => void),
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => {
  const context = () => ({
    user: { id: 'user-a', email: 'parent@example.test' },
    active: { role: 'parent', familyId: 'family-a', family: { name: 'Synthetic family' } },
    memberships: [{ familyId: 'family-a', role: 'parent', family: { name: 'Synthetic family' } }],
  });
  return { requireUserContext: vi.fn(async () => context()), getUserContext: vi.fn(async () => context()) };
});
vi.mock('@/lib/supabase/server', () => {
  const db = { from: (table: string) => {
    const builder = {
      select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: fake.rows[table] ?? null, error: null }),
      upsert: (value: Record<string, unknown>) => {
        const chain = { select: () => chain, maybeSingle: async () => ({ data: { ...value }, error: null }) };
        return chain;
      },
      insert: async () => ({ error: null }),
      update: () => {
        const chain = { eq: () => chain, select: async () => ({ data: [{ id: `${table}-row` }], error: null }) };
        return chain;
      },
    };
    return builder;
  } };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/stripe', async () => {
  const { default: prices } = await import('@/lib/constants/family-prices.json');
  const priceFor = (id: string) => {
    const plan = Object.entries(prices.stripePrices).find(([, entry]) => entry.id === id)?.[0] ?? 'basic_monthly';
    const annual = plan.endsWith('_annual'); const tier = plan.startsWith('plus') ? prices.plus : prices.basic;
    return { id, active: true, type: 'recurring', currency: 'usd', unit_amount: annual ? tier.annualCents : tier.monthlyCents,
      billing_scheme: 'per_unit', transform_quantity: null, custom_unit_amount: null,
      recurring: { interval: annual ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' } };
  };
  const stripe = {
    prices: { retrieve: async (id: string) => priceFor(id) },
    customers: { create: async () => { fake.trace.push('customer'); return { id: 'cus-new' }; } },
    subscriptions: {
      list: async (params: { customer: string }) => {
        fake.trace.push(`subscriptions.list:${params.customer}`);
        if (fake.listSubscriptionsFails) throw new Error('synthetic Stripe outage');
        const answer = { data: [...fake.subscriptions], has_more: fake.subscriptionsHaveMore };
        fake.afterSubscriptionsList?.();
        return answer;
      },
      retrieve: async () => { throw new Error('no subscription is changed in place in this suite'); },
      update: async () => { throw new Error('no subscription is changed in place in this suite'); },
    },
    checkout: { sessions: {
      create: async (params: { customer: string; mode: string }) => {
        fake.created += 1;
        const id = `cs-new-${fake.created}`;
        fake.trace.push(`create:${id}`);
        fake.sessions.push({ id, mode: params.mode, status: 'open', customer: params.customer });
        return { id, url: `https://checkout.example.test/${id}` };
      },
      list: async (params: { customer: string; status: string }) => {
        fake.trace.push(`sessions.list:${params.customer}`);
        return { data: fake.sessions.filter((s) => s.customer === params.customer && s.status === params.status), has_more: fake.sessionsHaveMore };
      },
      expire: async (id: string) => {
        const session = fake.sessions.find((s) => s.id === id)!;
        fake.trace.push(`expire:${id}`);
        if (fake.onExpire) { fake.onExpire(session); throw new Error('synthetic: session is not open'); }
        if (session.status !== 'open') throw new Error('synthetic: session is not open');
        session.status = 'expired';
        return session;
      },
      retrieve: async (id: string) => fake.sessions.find((s) => s.id === id)!,
    } },
  };
  return { getStripe: () => stripe, stripeFromKey: () => stripe, constructWebhookEvent: () => { throw new Error('unused'); }, STRIPE_PLANS: {
    basic_monthly: prices.stripePrices.basic_monthly.id, basic_annual: prices.stripePrices.basic_annual.id,
    plus_monthly: prices.stripePrices.plus_monthly.id, plus_annual: prices.stripePrices.plus_annual.id,
    family_monthly: prices.stripePrices.basic_monthly.id, family_annual: prices.stripePrices.basic_annual.id,
  } };
});
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => ({}), effectiveSecretKey: () => 'sk_test_synthetic', effectiveWebhookSecret: () => null,
}));
vi.mock('@/lib/stripe/service-fee', () => ({ serviceFeeAddInvoiceItems: () => undefined }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

const request = (plan: string) => new NextRequest('https://app.example.test/api/billing', { method: 'POST', body: JSON.stringify({ plan }) });
const created = () => fake.sessions.filter((s) => s.id.startsWith('cs-new-'));

beforeEach(() => {
  // A family the row says is on Free, who has paid Stripe before (so a customer exists).
  fake.rows = {
    subscriptions: { plan: 'free', status: 'active', provider_ref: null, cancel_at_period_end: false },
    billing_customers: { customer_ref: 'cus-a' },
    user_preferences: { active_family_id: 'family-a' },
  };
  fake.sessions = []; fake.subscriptions = []; fake.trace = []; fake.created = 0;
  fake.subscriptionsHaveMore = false; fake.sessionsHaveMore = false; fake.onExpire = null; fake.listSubscriptionsFails = false;
  fake.afterSubscriptionsList = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the billing page does not start a subscription Stripe already has', () => {
  it.each(['active', 'trialing', 'past_due'])('refuses a Checkout while a %s subscription has not reached the row yet', async (status) => {
    fake.subscriptions = [{ id: 'sub-just-paid', status }];
    const response = await changePlan(request('plus_monthly'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'subscription_exists', error: 'changePlan.aPlanIsAlreadyBeingConfirmed' });
    expect(created()).toEqual([]);
    expect(fake.trace).toContain('subscriptions.list:cus-a');
  });

  it('starts one Checkout when every subscription Stripe holds has ended (control)', async () => {
    fake.subscriptions = [{ id: 'sub-old', status: 'canceled' }, { id: 'sub-older', status: 'incomplete_expired' }];
    const response = await changePlan(request('plus_monthly'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'checkout', url: 'https://checkout.example.test/cs-new-1' });
    expect(created()).toHaveLength(1);
  });

  it('answers unavailable, not a new Checkout, when Stripe cannot list the subscriptions', async () => {
    fake.listSubscriptionsFails = true;
    const response = await changePlan(request('plus_monthly'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'changePlan.subscriptionStatusIsTemporarilyUnavailable' });
    expect(created()).toEqual([]);
  });
});

describe.each([['checkout', checkout], ['change-plan', changePlan]] as const)('%s leaves one payable Checkout', (_name, route) => {
  const refusedAsSubscribed = async (response: Response) => {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'subscription_exists' });
  };

  it('closes the older open subscription session before opening the new one', async () => {
    fake.sessions = [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }];
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(fake.sessions.find((s) => s.id === 'cs-old')!.status).toBe('expired');
    expect(fake.trace.indexOf('expire:cs-old')).toBeLessThan(fake.trace.indexOf('create:cs-new-1'));
    expect(fake.sessions.filter((s) => s.status === 'open').map((s) => s.id)).toEqual(['cs-new-1']);
  });

  it('closes every older open session, not only the newest', async () => {
    fake.sessions = [
      { id: 'cs-oldest', mode: 'subscription', status: 'open', customer: 'cus-a' },
      { id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' },
    ];
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(fake.sessions.map((s) => [s.id, s.status])).toEqual([['cs-oldest', 'expired'], ['cs-old', 'expired'], ['cs-new-1', 'open']]);
  });

  it('a second choice leaves only the newest session payable, and once that is paid nothing new starts', async () => {
    expect((await route(request('basic_monthly'))).status).toBe(200);
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(fake.sessions.map((s) => [s.id, s.status])).toEqual([['cs-new-1', 'expired'], ['cs-new-2', 'open']]);
    // The parent pays the open one; the webhook has not reached the row yet.
    fake.sessions[1].status = 'complete';
    fake.subscriptions = [{ id: 'sub-paid', status: 'active' }];
    await refusedAsSubscribed(await route(request('plus_monthly')));
    expect(created()).toHaveLength(2);
  });

  it('an older session paid between the two questions cannot leave a second one payable', async () => {
    // Why the sessions are closed BEFORE the subscriptions are listed. If the
    // parent pays the older session just after Stripe has answered "no live
    // subscription", that session is no longer open either, so nothing would
    // catch it and a new one would open beside a paid subscription. Closed
    // first, it can no longer be paid by then.
    fake.sessions = [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }];
    fake.afterSubscriptionsList = () => {
      const old = fake.sessions.find((s) => s.id === 'cs-old')!;
      if (old.status !== 'open') return;
      old.status = 'complete';
      fake.subscriptions.push({ id: 'sub-from-old', status: 'active' });
    };
    const response = await route(request('plus_monthly'));
    const paid = fake.sessions.filter((s) => s.status === 'complete');
    const payable = fake.sessions.filter((s) => s.status === 'open');
    expect(paid.length + payable.length, 'at most one session is paid or payable').toBeLessThanOrEqual(1);
    expect(response.status).toBe(200);
    expect(fake.sessions.find((s) => s.id === 'cs-old')!.status).toBe('expired');
  });

  it('refuses when the older session was paid while this request ran', async () => {
    fake.sessions = [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }];
    // Stripe completes it between our listing and our expire, so expire is refused.
    fake.onExpire = (session) => { session.status = 'complete'; };
    await refusedAsSubscribed(await route(request('plus_monthly')));
    expect(created()).toEqual([]);
  });

  it('carries on when a racing request already closed the older session', async () => {
    fake.sessions = [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }];
    fake.onExpire = (session) => { session.status = 'expired'; };
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(created()).toHaveLength(1);
  });

  it('answers unavailable when an older session cannot be closed', async () => {
    fake.sessions = [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }];
    fake.onExpire = () => {}; // refused, and still open
    expect((await route(request('plus_monthly'))).status).toBe(503);
    expect(created()).toEqual([]);
  });

  it('answers unavailable when the open sessions do not fit one page', async () => {
    fake.sessionsHaveMore = true;
    expect((await route(request('plus_monthly'))).status).toBe(503);
    expect(created()).toEqual([]);
  });

  it('answers unavailable when the subscriptions do not fit one page and none on it is live', async () => {
    fake.subscriptions = [{ id: 'sub-old', status: 'canceled' }];
    fake.subscriptionsHaveMore = true;
    expect((await route(request('plus_monthly'))).status).toBe(503);
    expect(created()).toEqual([]);
  });

  it('leaves a session that is not a subscription alone', async () => {
    fake.sessions = [{ id: 'cs-setup', mode: 'setup', status: 'open', customer: 'cus-a' }];
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(fake.sessions.find((s) => s.id === 'cs-setup')!.status).toBe('open');
  });

  it('asks about the customer it will charge when the family has none yet', async () => {
    fake.rows.billing_customers = null;
    expect((await route(request('plus_monthly'))).status).toBe(200);
    expect(fake.trace.indexOf('customer')).toBeLessThan(fake.trace.indexOf('sessions.list:cus-new'));
    expect(fake.trace.indexOf('subscriptions.list:cus-new')).toBeLessThan(fake.trace.indexOf('create:cs-new-1'));
  });
});

describe('checkNewSubscription', () => {
  const stripeFor = (overrides: Partial<{ sessions: Session[]; subscriptions: { id: string; status: string }[] }>) => {
    fake.sessions = overrides.sessions ?? [];
    fake.subscriptions = overrides.subscriptions ?? [];
    return {
      subscriptions: { list: async () => ({ data: fake.subscriptions, has_more: false }) },
      checkout: { sessions: {
        list: async () => ({ data: fake.sessions.filter((s) => s.status === 'open'), has_more: false }),
        expire: async (id: string) => { fake.sessions.find((s) => s.id === id)!.status = 'expired'; },
        retrieve: async (id: string) => fake.sessions.find((s) => s.id === id)!,
      } },
    };
  };

  it('is ok for a customer with nothing open and nothing live', async () => {
    expect(await checkNewSubscription(stripeFor({}), 'cus-a')).toEqual({ ok: true });
  });

  it.each(['unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'])('does not, today, count a %s subscription as one a Checkout would duplicate', async (status) => {
    // The same three statuses the in-place change accepts, and the same set
    // /api/billing/checkout counted before this check existed. Not all of the
    // rest is harmless: Stripe keeps raising invoices on an `unpaid` one, and an
    // `incomplete` one can still turn `active` once its first payment clears. But
    // counting them would leave such a family with no way to subscribe here at
    // all (the in-place change refuses them too), so that is the owner's call,
    // and this pins today's answer.
    expect(await checkNewSubscription(stripeFor({ subscriptions: [{ id: 'sub-x', status }] }), 'cus-a')).toEqual({ ok: true });
  });

  it('never throws: a listing that rejects is unavailable', async () => {
    const broken = stripeFor({});
    broken.checkout.sessions.list = async () => { throw new Error('synthetic outage'); };
    expect(await checkNewSubscription(broken, 'cus-a')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a retrieve that rejects after a refused expire is unavailable, not a new Checkout', async () => {
    const stripe = stripeFor({ sessions: [{ id: 'cs-old', mode: 'subscription', status: 'open', customer: 'cus-a' }] });
    stripe.checkout.sessions.expire = async () => { throw new Error('synthetic: refused'); };
    stripe.checkout.sessions.retrieve = async () => { throw new Error('synthetic outage'); };
    expect(await checkNewSubscription(stripe, 'cus-a')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
