// The billing webhook does not consume events it cannot process.
//
// `/api/webhooks/stripe` (billing) and `/api/webhooks/money` (Issuing/Connect)
// share ONE idempotency ledger, `stripe_webhook_events`, unique on
// `stripe_event_id` alone. Audit C1-S4-01 stopped the money route from claiming
// billing events; the billing route still claimed every type it was sent and,
// having no handler for it, marked it `processed`. When an issuing event reached
// both endpoints — a billing endpoint subscribed beyond its four types, or the
// LB-006 smoke's `stripe listen`, which forwards every event — the money
// delivery then read `duplicate` and answered 200 without applying it: a
// child's card spend never debited, its hold never released. Both endpoints
// 2xx, so Stripe never retries and nothing logs.
//
// Both real routes and the real ledger (recordEvent / markEventProcessed) run
// here against the in-memory Postgres fake; only the money handlers' effects
// and Stripe's signature check are stubbed.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  event: null as unknown,
  db: null as unknown,
  applied: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/stripe', () => ({
  constructWebhookEvent: () => h.event,
  stripeFromKey: () => { throw new Error('no Stripe call is expected'); },
  getStripe: () => { throw new Error('no Stripe call is expected'); },
}));
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => ({}),
  effectiveWebhookSecret: () => 'whsec_billing_fixture',
  effectiveSecretKey: () => null,
}));
vi.mock('@/lib/stripe/webhook', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/stripe/webhook')>();
  // Each money handler records the event it was handed, and does nothing else.
  const record = async () => { h.applied.push((h.event as { type: string }).type); };
  return {
    ...actual,
    handleTransactionCreated: vi.fn(record),
    handleAuthorizationUpdated: vi.fn(record),
    handleIssuingCardUpdated: vi.fn(record),
    handleAuthorizationRequest: vi.fn(record),
  };
});
vi.mock('@/lib/wallet/server', () => ({ reserveCardAuth: vi.fn(), releaseCardHold: vi.fn(), debitCardSpend: vi.fn(), creditCardRefund: vi.fn() }));
vi.mock('@/lib/stripe/connect', () => ({ syncConnectedAccount: vi.fn(async () => { h.applied.push((h.event as { type: string }).type); return true; }) }));
vi.mock('@/lib/referrals/server', () => ({ markReferralConverted: async () => {}, rewardConvertedReferral: async () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));

import { POST as billing } from '@/app/api/webhooks/stripe/route';
import { POST as money } from '@/app/api/webhooks/money/route';

type Ledger = { table(name: string): Record<string, unknown>[] };
const ledger = () => (h.db as Ledger).table('stripe_webhook_events');

const deliver = (path: string, event: Record<string, unknown>) => {
  h.event = event;
  return new NextRequest(`https://app.example.test${path}`, { method: 'POST', body: '{}', headers: { 'stripe-signature': 'sig' } });
};
const moneyEvent = (id: string, type: string) =>
  ({ id, type, created: 1_900_000_000, data: { object: { id: `obj_${id}`, metadata: { family_id: 'family-a' } } } });

beforeEach(() => {
  h.db = createInMemorySupabase({ uniques: { stripe_webhook_events: [['stripe_event_id']] } });
  h.applied = [];
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', 'whsec_money_fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('an event only the money webhook handles', () => {
  it.each([
    'issuing_transaction.created',
    'issuing_authorization.created',
    'issuing_authorization.updated',
    'issuing_card.updated',
    'account.updated',
  ])('%s is acknowledged by the billing route without being claimed, and still applied by the money route', async (type) => {
    const event = moneyEvent(`evt_${type}`, type);

    // The billing endpoint answers first — it has nothing to do for this type.
    const billed = await billing(deliver('/api/webhooks/stripe', event));
    expect(billed.status).toBe(200);

    // The money endpoint's delivery of the SAME event is not a duplicate.
    const paid = await money(deliver('/api/webhooks/money', event));
    expect(await paid.json()).toEqual({ received: true });
    expect(h.applied).toEqual([type]);
    expect(ledger()).toMatchObject([{ stripe_event_id: event.id, status: 'processed' }]);

    // Acknowledged as not handled — the shape the money route uses for the same case.
    expect(await billed.json()).toEqual({ received: true, handled: false });
  });
});

describe('an event neither webhook handles', () => {
  it('is acknowledged without a ledger row (invoice.paid: the subscription event carries the state)', async () => {
    const response = await billing(deliver('/api/webhooks/stripe', moneyEvent('evt_invoice', 'invoice.paid')));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, handled: false });
    expect(ledger()).toEqual([]);
  });
});

describe('the billing route still claims and finishes its own events', () => {
  it('records a handled event as processed, and a redelivery is a duplicate', async () => {
    // A subscription with no Bubaly family: handled (nothing to write), so claimed.
    const event = { id: 'evt_sub', type: 'customer.subscription.updated', created: 1_900_000_000,
      data: { object: { id: 'sub_other', status: 'active', metadata: {} } } };
    const first = await billing(deliver('/api/webhooks/stripe', event));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(ledger()).toMatchObject([{ stripe_event_id: 'evt_sub', status: 'processed' }]);

    const again = await billing(deliver('/api/webhooks/stripe', event));
    expect(await again.json()).toEqual({ received: true, duplicate: true });
  });
});
