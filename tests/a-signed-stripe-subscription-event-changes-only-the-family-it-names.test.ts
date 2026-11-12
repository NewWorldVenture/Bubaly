// POST /api/webhooks/stripe, driven end to end (Register B API-ED756A60DF1B).
//
// What the neighbouring tests already prove, and this file does not repeat:
//  - the signing secret saved in Stripe Setup is used before the environment's
//    (tests/billing-uses-the-stripe-keys-the-admin-configured.test.ts);
//  - the payload is bounded and an unset secret fails closed, read from source
//    (tests/stripe-webhook-replay-contract.test.ts);
//  - an unfinished claim is in_flight, not duplicate, against the real ledger
//    (tests/stripe-webhook-unfinished-claims.test.ts);
//  - the current state is read from Stripe, not the payload, and a failed Stripe
//    read is retried (tests/billing-price-verification.test.ts);
//  - resubscription, duplicate live subscriptions and unknown prices
//    (tests/billing-subscription-integrity.test.ts);
//  - money event types are left unclaimed for /api/webhooks/money
//    (tests/the-billing-webhook-leaves-money-events-to-the-money-webhook.test.ts).
//
// What is added here: a real Stripe-signed request through the real handler,
// the real event ledger (lib/stripe/webhook.ts) and the real customer/row
// writers over the in-memory database seeded with TWO households — unsigned,
// wrongly signed, tampered and correctly signed deliveries; the rows a valid
// event writes, read back; a replay that applies nothing twice; household B's
// rows untouched by household A's event (and an event naming no family not
// resolved to B by its customer id); and a failed subscription read answered
// with a retryable 500, no internal text, nothing written.
import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FAMILY_PRICES from '@/lib/constants/family-prices.json';
import { InMemorySupabase, withFaults, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  settings: null as Record<string, string | null> | null,
  retrieve: null as unknown as (id: string) => Promise<unknown>,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/stripe/settings', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/stripe/settings')>()),
  getStripeSettings: async () => h.settings,
}));
// The seam the billing tests use: signature verification stays REAL
// (constructWebhookEvent is Stripe's own), only the API client is stubbed.
vi.mock('@/lib/stripe', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/stripe')>()),
  stripeFromKey: () => ({ subscriptions: { retrieve: (id: string) => h.retrieve(id) } }),
}));
const referrals = vi.hoisted(() => ({ markReferralConverted: vi.fn(async () => undefined), rewardConvertedReferral: vi.fn(async () => null) }));
vi.mock('@/lib/referrals/server', () => referrals);
const automation = vi.hoisted(() => ({ fireAutomationEvent: vi.fn(async () => ({ workflows: 0, emails: 0, failures: 0 })) }));
vi.mock('@/lib/marketing/automation-events', () => automation);

import { POST } from '@/app/api/webhooks/stripe/route';

const SIGNING_SECRET = 'whsec_fake_audit_fixture_0000000000';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const BC_A = 'a0000000-0000-4000-8000-0000000000c1';
const BC_B = 'b0000000-0000-4000-8000-0000000000c2';
const SUB_ROW_B = 'b0000000-0000-4000-8000-0000000000d2';
const BASIC_PRICE = FAMILY_PRICES.stripePrices.basic_monthly.id;
const PERIOD_END = 1_790_000_000; // 2026-09-21T14:13:20Z
const INJECTED = 'injected subscriptions read failure: relation detail';

let failSubscriptionRead = false;
let retrieved: string[] = [];
let db: InMemorySupabase;

function stripeSubscription(id: string, familyId: string | null, customer: string, status = 'active') {
  return {
    id, object: 'subscription', status, customer, cancel_at_period_end: false,
    metadata: familyId ? { family_id: familyId } : {},
    items: { object: 'list', has_more: false, data: [{ id: `si_${id}`, price: { id: BASIC_PRICE }, current_period_end: PERIOD_END }] },
  };
}

/** Stripe's own current state, keyed by subscription id: what `retrieve` answers. */
let stripeState: Record<string, unknown> = {};

function seed() {
  db = new InMemorySupabase({ uniques: {
    stripe_webhook_events: [['stripe_event_id']], billing_customers: [['family_id']], checkout_sessions: [['session_id']],
  } });
  db.seed('families', [{ id: FAMILY_A, name: 'Household A' }, { id: FAMILY_B, name: 'Household B' }]);
  db.seed('billing_customers', [
    { id: BC_A, family_id: FAMILY_A, provider: 'stripe', customer_ref: 'cus_fake_household_a' },
    { id: BC_B, family_id: FAMILY_B, provider: 'stripe', customer_ref: 'cus_fake_household_b' },
  ]);
  db.seed('subscriptions', [{
    id: SUB_ROW_B, family_id: FAMILY_B, billing_customer_id: BC_B, plan: 'plus', status: 'active',
    provider_ref: 'sub_fake_household_b', current_period_end: '2026-12-01T00:00:00.000Z', cancel_at_period_end: false, seats: 10,
  }]);
  h.db = withFaults(db, (table, calls) =>
    failSubscriptionRead && table === 'subscriptions' && calls[0]?.method === 'select' ? { message: INJECTED } : null);
}

function signedRequest(event: unknown, options: { secret?: string; signature?: string | null; sentBody?: string; cookie?: string } = {}) {
  const payload = JSON.stringify(event);
  const header = options.signature === undefined
    ? Stripe.webhooks.generateTestHeaderString({ payload, secret: options.secret ?? SIGNING_SECRET })
    : options.signature;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header !== null) headers['stripe-signature'] = header;
  if (options.cookie) headers.cookie = options.cookie;
  return new NextRequest('https://app.example.com/api/webhooks/stripe', { method: 'POST', body: options.sentBody ?? payload, headers });
}

function subscriptionEvent(id: string, type: string, object: unknown) {
  return { id, object: 'event', type, created: 1_789_000_000, data: { object } };
}

const snapshot = (table: string, familyId: string) =>
  structuredClone(db.table(table).filter((row: Row) => row.family_id === familyId || row.related_id === familyId));

beforeEach(() => {
  failSubscriptionRead = false;
  retrieved = [];
  stripeState = {};
  h.settings = { secret_key: 'sk_test_fake_audit_fixture', webhook_secret: SIGNING_SECRET };
  h.retrieve = async (id: string) => {
    retrieved.push(id);
    const sub = stripeState[id];
    if (!sub) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    return sub;
  };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  referrals.markReferralConverted.mockClear();
  referrals.rewardConvertedReferral.mockClear();
  automation.fireAutomationEvent.mockClear();
  seed();
});
afterEach(() => { vi.restoreAllMocks(); });

const createdForA = () => {
  stripeState.sub_fake_household_a = stripeSubscription('sub_fake_household_a', FAMILY_A, 'cus_fake_household_a');
  return subscriptionEvent('evt_fake_audit_a_created', 'customer.subscription.created', stripeSubscription('sub_fake_household_a', FAMILY_A, 'cus_fake_household_a'));
};

function expectNothingClaimedOrWritten(beforeB: Row[]) {
  expect(db.table('stripe_webhook_events')).toEqual([]);
  expect(db.table('subscriptions').filter((row) => row.family_id === FAMILY_A)).toEqual([]);
  expect(snapshot('subscriptions', FAMILY_B)).toEqual(beforeB);
  expect(db.table('admin_notifications')).toEqual([]);
  expect(retrieved).toEqual([]);
  expect(referrals.markReferralConverted).not.toHaveBeenCalled();
}

describe('API-ED756A60DF1B who may deliver a billing event', () => {
  it('API-ED756A60DF1B an unsigned delivery, even one carrying a member session cookie, is refused and writes nothing', async () => {
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const response = await POST(signedRequest(createdForA(), { signature: null, cookie: 'sb-access-token=fake-parent-session' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'stripe.webhookSignatureInvalid' });
    expectNothingClaimedOrWritten(beforeB);
  });

  it('API-ED756A60DF1B a delivery signed with another secret is refused and writes nothing', async () => {
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const response = await POST(signedRequest(createdForA(), { secret: 'whsec_fake_someone_elses_secret_0000' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'stripe.webhookSignatureInvalid' });
    expectNothingClaimedOrWritten(beforeB);
  });

  it('API-ED756A60DF1B a correctly signed header over a different body is refused (the body is what was signed)', async () => {
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const forged = subscriptionEvent('evt_fake_audit_forged', 'customer.subscription.created',
      stripeSubscription('sub_fake_household_b', FAMILY_B, 'cus_fake_household_b', 'canceled'));
    const response = await POST(signedRequest(createdForA(), { sentBody: JSON.stringify(forged) }));
    expect(response.status).toBe(400);
    expectNothingClaimedOrWritten(beforeB);
  });

  it('API-ED756A60DF1B with no signing secret configured anywhere, a delivery is 503 and nothing is claimed', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    h.settings = { secret_key: 'sk_test_fake_audit_fixture', webhook_secret: null };
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const response = await POST(signedRequest(createdForA()));
    vi.unstubAllEnvs();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'stripe.webhookNotConfigured' });
    expectNothingClaimedOrWritten(beforeB);
  });
});

describe('API-ED756A60DF1B a correctly signed subscription event, end to end', () => {
  it('API-ED756A60DF1B records household A\'s subscription from Stripe\'s current state, finishes the ledger row, and leaves household B as it was', async () => {
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const beforeBCustomer = snapshot('billing_customers', FAMILY_B);
    const response = await POST(signedRequest(createdForA()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    expect(retrieved).toEqual(['sub_fake_household_a']);
    const rowsA = db.table('subscriptions').filter((row) => row.family_id === FAMILY_A);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      billing_customer_id: BC_A, plan: 'basic', status: 'active', provider_ref: 'sub_fake_household_a',
      current_period_end: '2026-09-21T14:13:20.000Z', cancel_at_period_end: false, seats: 10,
    });
    expect(snapshot('subscriptions', FAMILY_B)).toEqual(beforeB);
    expect(snapshot('billing_customers', FAMILY_B)).toEqual(beforeBCustomer);

    const ledger = db.table('stripe_webhook_events');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ stripe_event_id: 'evt_fake_audit_a_created', type: 'customer.subscription.created', status: 'processed' });

    const alerts = db.table('admin_notifications');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'subscription', related_type: 'subscription', related_id: FAMILY_A, title: 'New paid conversion: Household A' });
    expect(referrals.markReferralConverted).toHaveBeenCalledExactlyOnceWith(db, FAMILY_A);
  });

  it('API-ED756A60DF1B a replayed event is acknowledged as a duplicate and applies nothing a second time', async () => {
    const event = createdForA();
    expect((await POST(signedRequest(event))).status).toBe(200);
    const afterFirst = structuredClone(db.table('subscriptions'));

    // Stripe would now report a different state; a replay must not read or write it.
    stripeState.sub_fake_household_a = stripeSubscription('sub_fake_household_a', FAMILY_A, 'cus_fake_household_a', 'past_due');
    const replay = await POST(signedRequest(event));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });

    expect(retrieved).toEqual(['sub_fake_household_a']);
    expect(db.table('subscriptions')).toEqual(afterFirst);
    expect(db.table('admin_notifications')).toHaveLength(1);
    expect(db.table('stripe_webhook_events')).toHaveLength(1);
    expect(referrals.markReferralConverted).toHaveBeenCalledTimes(1);
  });

  it('API-ED756A60DF1B a completed checkout records the customer and session for the family it names, and no other', async () => {
    const beforeBCustomer = snapshot('billing_customers', FAMILY_B);
    const session = {
      id: 'cs_fake_audit_a', object: 'checkout.session', customer: 'cus_fake_household_a_new',
      customer_details: { email: 'buyer-a@example.com', name: 'Fixture Buyer' },
      metadata: { family_id: FAMILY_A, plan: 'basic_monthly' },
    };
    const response = await POST(signedRequest(subscriptionEvent('evt_fake_audit_checkout', 'checkout.session.completed', session)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const customersA = db.table('billing_customers').filter((row) => row.family_id === FAMILY_A);
    expect(customersA).toHaveLength(1);
    expect(customersA[0]).toMatchObject({ id: BC_A, customer_ref: 'cus_fake_household_a_new' });
    expect(snapshot('billing_customers', FAMILY_B)).toEqual(beforeBCustomer);
    const sessions = db.table('checkout_sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ session_id: 'cs_fake_audit_a', family_id: FAMILY_A, email: 'buyer-a@example.com', plan: 'basic_monthly', status: 'completed' });
    expect(automation.fireAutomationEvent).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({
      trigger: 'payment_completed', email: 'buyer-a@example.com', context: { familyId: FAMILY_A, sessionId: 'cs_fake_audit_a' },
    }));
  });
});

describe('API-ED756A60DF1B another household\'s ids', () => {
  it('API-ED756A60DF1B a subscription event naming no family is not resolved to household B by B\'s Stripe customer id', async () => {
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const orphan = stripeSubscription('sub_fake_unowned', null, 'cus_fake_household_b', 'canceled');
    const response = await POST(signedRequest(subscriptionEvent('evt_fake_audit_orphan', 'customer.subscription.updated', orphan)));
    expect(response.status).toBe(200);
    expect(snapshot('subscriptions', FAMILY_B)).toEqual(beforeB);
    expect(db.table('subscriptions')).toHaveLength(1);
    expect(retrieved).toEqual([]);
  });
});

describe('API-ED756A60DF1B a failed read', () => {
  it('API-ED756A60DF1B a failed subscription read is a retryable 500 with no internal text, nothing written, and the retry applies it once', async () => {
    failSubscriptionRead = true;
    const event = createdForA();
    const beforeB = snapshot('subscriptions', FAMILY_B);
    const response = await POST(signedRequest(event));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'stripe.handlerFailed' });
    expect(text).not.toContain('injected');
    expect(db.table('subscriptions').filter((row) => row.family_id === FAMILY_A)).toEqual([]);
    expect(snapshot('subscriptions', FAMILY_B)).toEqual(beforeB);
    expect(db.table('stripe_webhook_events')[0]).toMatchObject({ stripe_event_id: 'evt_fake_audit_a_created', status: 'error' });
    expect(db.table('admin_notifications')).toEqual([]);

    failSubscriptionRead = false;
    const retry = await POST(signedRequest(event));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true });
    expect(db.table('subscriptions').filter((row) => row.family_id === FAMILY_A)).toHaveLength(1);
    expect(db.table('stripe_webhook_events')[0]).toMatchObject({ status: 'processed' });
  });
});
