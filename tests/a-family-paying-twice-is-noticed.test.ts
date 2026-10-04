// A family that is paying for two subscriptions keeps what it pays for, and
// someone is told.
//
// The checkout routes now refuse to start a second subscription
// (tests/a-family-is-never-subscribed-twice.test.ts), but two can still exist:
// ones started before that check, and the narrow races it documents. The
// webhook keeps ONE `subscriptions` row per family, and it handled two live
// subscriptions badly:
//
//  - The row followed whichever subscription last sent an event, so the plan
//    the family is entitled to flipped with each renewal.
//  - When the subscription the row follows ended (the parent cancelled it),
//    the row was written `canceled` while the other one went on charging: a
//    family billed every month with no plan.
//  - Nobody was told, so nobody refunded the second subscription.
//
// Stripe is an in-memory fake; ids and prices are synthetic or the catalogue's.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PRICES from '@/lib/constants/family-prices.json';
import { POST as webhook } from '@/app/api/webhooks/stripe/route';

type Sub = {
  id: string; status: string; customer: string; metadata: Record<string, string>; price: string;
  created?: number; ended_at?: number | null; cancel_at_period_end?: boolean;
};
type Note = { kind: string; title: string; body?: string | null; relatedType?: string | null; relatedId?: string | null; meta?: Record<string, unknown>; is_read: boolean };

const fake = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  billingCustomerRef: 'cus_a' as string | null,
  writes: [] as { table: string; op: string; value: Record<string, unknown> }[],
  notes: [] as { kind: string; title: string; body?: string | null; relatedType?: string | null; relatedId?: string | null; meta?: Record<string, unknown>; is_read: boolean }[],
  subs: [] as { id: string; status: string; customer: string; metadata: Record<string, string>; price: string; created?: number; ended_at?: number | null; cancel_at_period_end?: boolean }[],
  event: null as null | { id: string; type: string; data: { object: unknown } },
  listFails: false,
  goneCustomers: new Set<string>(),
  retrieveFails: new Map<string, string>(),
  retrieved: [] as string[],
  processed: 0,
  errored: 0,
}));

const PLUS = PRICES.stripePrices.plus_monthly.id;
const BASIC = PRICES.stripePrices.basic_monthly.id;
const T0 = 1_780_000_000; // the first subscription began
const T1 = T0 + 86_400 * 30; // the second began, a month later
const T2 = T0 + 86_400 * 60; // the first ended

function stripeSub(s: Sub) {
  return {
    id: s.id, status: s.status, customer: s.customer, metadata: s.metadata, cancel_at_period_end: s.cancel_at_period_end ?? false,
    created: s.created ?? T0, ended_at: s.ended_at ?? null, canceled_at: s.ended_at ?? null,
    items: { has_more: false, data: [{ id: `si_${s.id}`, price: { id: s.price }, current_period_end: 1_900_000_000 }] },
  };
}

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/stripe', () => {
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        fake.retrieved.push(id);
        const code = fake.retrieveFails.get(id);
        if (code) throw Object.assign(new Error(`synthetic: ${code}`), { code });
        const s = fake.subs.find((x) => x.id === id);
        if (!s) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
        return stripeSub(s);
      },
      list: async (params: { customer: string }) => {
        if (fake.listFails) throw new Error('synthetic Stripe outage');
        if (fake.goneCustomers.has(params.customer)) throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
        return { data: fake.subs.filter((s) => s.customer === params.customer).map(stripeSub), has_more: false };
      },
    },
  };
  return { stripeFromKey: () => stripe, getStripe: () => stripe, constructWebhookEvent: () => fake.event };
});
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => ({}), effectiveSecretKey: () => 'sk_test_synthetic', effectiveWebhookSecret: () => 'whsec_synthetic',
}));
vi.mock('@/lib/stripe/webhook', () => ({
  recordEvent: async () => ({ outcome: 'fresh', claimToken: 'claim-synthetic' }),
  markEventProcessed: async () => { fake.processed += 1; },
  markEventError: async () => { fake.errored += 1; },
}));
vi.mock('@/lib/referrals/server', () => ({ markReferralConverted: async () => {}, rewardConvertedReferral: async () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/admin/notify', () => ({
  recordAdminNotification: async (_db: unknown, input: Omit<Note, 'is_read'>) => { fake.notes.push({ ...input, is_read: false }); },
}));
vi.mock('@/lib/supabase/server', () => {
  const db = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters[column] = value; return builder; },
        is: () => builder, in: () => builder, order: () => builder, limit: () => builder,
        maybeSingle: async () => {
          if (table === 'subscriptions') return { data: fake.row, error: null };
          if (table === 'billing_customers') return { data: { id: 'bc-a', customer_ref: fake.billingCustomerRef }, error: null };
          if (table === 'families') return { data: { name: 'Synthetic family' }, error: null };
          if (table === 'admin_notifications') {
            // Honours every filter the route sends, so a query that drops one is caught.
            const hit = fake.notes.find((n) => (!('related_type' in filters) || n.relatedType === filters.related_type)
              && (!('related_id' in filters) || n.relatedId === filters.related_id)
              && (!('is_read' in filters) || n.is_read === filters.is_read));
            const unfiltered = !('related_type' in filters) || !('related_id' in filters) || !('is_read' in filters);
            // A query missing a filter matches the first note of any kind, as PostgREST would.
            const any = unfiltered ? fake.notes[0] : hit;
            return { data: any ? { id: 'note' } : null, error: null };
          }
          return { data: null, error: null };
        },
        update: (value: Record<string, unknown>) => {
          const chain = {
            eq: () => chain,
            select: async () => {
              fake.writes.push({ table, op: 'update', value });
              if (table === 'subscriptions' && fake.row) { fake.row = { ...fake.row, ...value }; return { data: [{ id: 'row' }], error: null }; }
              return { data: [], error: null };
            },
          };
          return chain;
        },
        insert: async (value: Record<string, unknown>) => {
          fake.writes.push({ table, op: 'insert', value });
          if (table === 'subscriptions') fake.row = { ...value };
          return { error: null };
        },
      };
      return builder;
    },
  };
  return { createServiceClient: () => db, createServer: async () => db };
});

function deliver(type: string, sub: Sub) {
  fake.event = { id: `evt_${type}_${sub.id}`, type, data: { object: stripeSub(sub) } };
  return webhook(new NextRequest('https://app.example.test/api/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=synthetic' } }));
}
const family = { family_id: 'family-a' };
const subscriptionWrites = () => fake.writes.filter((w) => w.table === 'subscriptions');
const duplicateAlerts = () => fake.notes.filter((n) => n.relatedType === 'subscription_duplicate');

beforeEach(() => {
  fake.writes = []; fake.notes = []; fake.listFails = false; fake.processed = 0; fake.errored = 0;
  fake.goneCustomers = new Set(); fake.retrieveFails = new Map(); fake.retrieved = []; fake.billingCustomerRef = 'cus_a';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the subscription the row follows ends while another still bills the family', () => {
  beforeEach(() => {
    fake.row = { plan: 'plus', status: 'active', provider_ref: 'sub_A' };
    fake.subs = [
      { id: 'sub_A', status: 'canceled', customer: 'cus_a', metadata: family, price: PLUS, created: T0, ended_at: T2 },
      { id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, price: BASIC, created: T1 },
    ];
  });

  it('follows the subscription still billing them instead of writing the family canceled', async () => {
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active', plan: 'basic' });
    expect(subscriptionWrites().some((w) => w.value.status === 'canceled')).toBe(false);
    expect(duplicateAlerts()).toHaveLength(1);
    expect(duplicateAlerts()[0]).toMatchObject({ relatedId: 'family-a', meta: { subscriptions: ['sub_A', 'sub_B'] } });
    // Not the kind the bell and the digest read as a new paid plan.
    expect(duplicateAlerts()[0].kind).not.toBe('subscription');
    // The switch does not re-read the subscription it replaces.
    expect(fake.retrieved).toEqual(['sub_A']);
  });

  it.each(['canceled', 'unpaid', 'incomplete_expired'])('treats a followed subscription that is %s as ended', async (status) => {
    fake.subs[0].status = status;
    expect((await deliver('customer.subscription.updated', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active' });
  });

  it('finds the other subscription on the family\'s second Stripe customer', async () => {
    fake.subs[1].customer = 'cus_b';
    fake.billingCustomerRef = 'cus_b';
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active' });
  });

  it('adopts the live one for a family whose row has no subscription yet', async () => {
    fake.row = { plan: 'free', status: 'active', provider_ref: null };
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active', plan: 'basic' });
  });

  it('is an ordinary switch, with no alert, when the other one began after this one ended', async () => {
    fake.subs[1].created = T2 + 86_400; // resubscribed; the old deletion is processed late
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active' });
    expect(duplicateAlerts()).toHaveLength(0);
  });

  it('records the end, and says what is still billing, when the other one maps to no plan', async () => {
    fake.subs[1].price = 'price_unknown_synthetic';
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', status: 'canceled' });
    expect(duplicateAlerts()).toHaveLength(1);
    expect(duplicateAlerts()[0].body).toContain('sub_B');
  });

  it('writes the family canceled when nothing else bills them (control)', async () => {
    fake.subs = [fake.subs[0], { id: 'sub_old', status: 'canceled', customer: 'cus_a', metadata: family, price: BASIC }];
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', status: 'canceled' });
    expect(duplicateAlerts()).toHaveLength(0);
  });

  it('does not adopt a live subscription that belongs to another family', async () => {
    fake.subs[1].metadata = { family_id: 'family-b' };
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', status: 'canceled' });
  });

  it('reads a customer Stripe no longer has as billing nobody', async () => {
    fake.goneCustomers.add('cus_a');
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', status: 'canceled' });
  });

  it('asks Stripe to retry, writing nothing, when it cannot tell whether another one bills them', async () => {
    fake.listFails = true;
    expect((await deliver('customer.subscription.deleted', fake.subs[0])).status).toBe(500);
    expect(subscriptionWrites()).toEqual([]);
    expect(fake.errored).toBe(1);
  });
});

describe('a second live subscription for a family that already has one', () => {
  beforeEach(() => {
    fake.row = { plan: 'plus', status: 'active', provider_ref: 'sub_A' };
    fake.subs = [
      { id: 'sub_A', status: 'active', customer: 'cus_a', metadata: family, price: PLUS, created: T0 },
      { id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, price: BASIC, created: T1 },
    ];
  });

  it('keeps the row on the plan it already pays for, and says so once while unread', async () => {
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', plan: 'plus' });
    expect(duplicateAlerts()).toHaveLength(1);
    // B renews a month later; the row does not flip and nobody is told twice.
    expect((await deliver('customer.subscription.updated', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', plan: 'plus' });
    expect(duplicateAlerts()).toHaveLength(1);
    // Once someone has read it, a family still paying twice is raised again.
    fake.notes[0].is_read = true;
    expect((await deliver('customer.subscription.updated', fake.subs[1])).status).toBe(200);
    expect(duplicateAlerts()).toHaveLength(2);
  });

  it('is not silenced by another family\'s unread alert, or by an unrelated note', async () => {
    fake.notes.push({ kind: 'info', title: 'Billed twice: another family', relatedType: 'subscription_duplicate', relatedId: 'family-b', is_read: false });
    fake.notes.push({ kind: 'info', title: 'Something else', relatedType: 'other', relatedId: 'family-a', is_read: false });
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(duplicateAlerts().filter((n) => n.relatedId === 'family-a')).toHaveLength(1);
  });

  it('keeps the recorded one on a tie', async () => {
    fake.subs[1].price = PLUS;
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', plan: 'plus' });
    expect(subscriptionWrites()).toEqual([]);
    expect(duplicateAlerts()).toHaveLength(1);
  });

  it('moves the row to the second one when it is the higher plan', async () => {
    fake.row = { plan: 'basic', status: 'active', provider_ref: 'sub_A' };
    fake.subs[0].price = BASIC; fake.subs[1].price = PLUS;
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', plan: 'plus' });
    expect(duplicateAlerts()).toHaveLength(1);
  });

  it('on the same plan, follows the one being paid over the one past due', async () => {
    fake.row = { plan: 'plus', status: 'past_due', provider_ref: 'sub_A' };
    fake.subs[0].status = 'past_due'; fake.subs[1].price = PLUS;
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', status: 'active' });
  });

  it('does not trade an active plan for a higher one that is past due (it grants nothing)', async () => {
    fake.row = { plan: 'basic', status: 'active', provider_ref: 'sub_A' };
    fake.subs[0].price = BASIC;
    fake.subs[1] = { ...fake.subs[1], price: PLUS, status: 'past_due' };
    expect((await deliver('customer.subscription.updated', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', status: 'active', plan: 'basic' });
  });

  it('asks Stripe to retry, writing nothing, when it cannot read the recorded one', async () => {
    fake.retrieveFails.set('sub_A', 'rate_limit');
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(500);
    expect(subscriptionWrites()).toEqual([]);
    expect(duplicateAlerts()).toHaveLength(0);
  });

  it('is an ordinary switch when Stripe no longer has the recorded one', async () => {
    fake.retrieveFails.set('sub_A', 'resource_missing');
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', plan: 'basic' });
    expect(duplicateAlerts()).toHaveLength(0);
  });

  it('is an ordinary switch when the recorded one has in fact ended at Stripe (control)', async () => {
    fake.subs[0].status = 'canceled'; // its deletion event has not arrived yet
    expect((await deliver('customer.subscription.created', fake.subs[1])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_B', plan: 'basic', status: 'active' });
    expect(duplicateAlerts()).toHaveLength(0);
  });

  it('records an ordinary renewal of the one subscription the family has (control)', async () => {
    expect((await deliver('customer.subscription.updated', fake.subs[0])).status).toBe(200);
    expect(fake.row).toMatchObject({ provider_ref: 'sub_A', plan: 'plus' });
    expect(duplicateAlerts()).toHaveLength(0);
    expect(fake.retrieved).toEqual(['sub_A']);
  });
});
