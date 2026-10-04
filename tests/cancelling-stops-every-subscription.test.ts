// Cancelling the plan stops everything that bills the family for it.
//
// /api/billing/cancel set `cancel_at_period_end` on the one subscription the
// family's row follows. A family Stripe bills for two (see
// tests/a-family-paying-twice-is-noticed.test.ts) went on paying for the other
// after cancelling, and when the cancelled one ended the webhook rightly
// followed the one still billing them, so the plan they had cancelled carried
// on, and so did the charges. Cancelling now schedules every live subscription
// of the family to end; resuming resumes only the one the row follows.
//
// Stripe is an in-memory fake; ids are synthetic.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as cancel } from '@/app/api/billing/cancel/route';

const fake = vi.hoisted(() => ({
  subs: [] as { id: string; status: string; customer: string; metadata: Record<string, string>; cancel_at_period_end: boolean }[],
  row: { provider_ref: 'sub_A', status: 'active' } as Record<string, unknown> | null,
  billingCustomerRef: 'cus_a' as string | null,
  listFails: false,
  updateFailsFor: new Set<string>(),
  updates: [] as { id: string; cancel_at_period_end: boolean }[],
  syncs: 0,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-a', email: 'parent@example.test' },
    active: { role: 'parent', familyId: 'family-a', family: { name: 'Synthetic family' } },
  }),
}));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => ({}), effectiveSecretKey: () => 'sk_test_synthetic' }));
vi.mock('@/lib/supabase/server', () => {
  const db = {
    from: (table: string) => {
      const builder = {
        select: () => builder, eq: () => builder,
        maybeSingle: async () => {
          if (table === 'subscriptions') return { data: fake.row, error: null };
          if (table === 'billing_customers') return { data: { customer_ref: fake.billingCustomerRef }, error: null };
          return { data: null, error: null };
        },
        update: () => {
          const chain = { eq: () => chain, select: async () => { fake.syncs += 1; return { data: [{ id: 'row' }], error: null }; } };
          return chain;
        },
      };
      return builder;
    },
  };
  return { createServer: async () => db, createServiceClient: () => db };
});
vi.mock('@/lib/stripe', () => {
  const stripe = {
    subscriptions: {
      update: async (id: string, params: { cancel_at_period_end: boolean }) => {
        if (fake.updateFailsFor.has(id)) throw new Error('synthetic Stripe outage');
        fake.updates.push({ id, cancel_at_period_end: params.cancel_at_period_end });
        const s = fake.subs.find((x) => x.id === id)!;
        s.cancel_at_period_end = params.cancel_at_period_end;
        return { ...s };
      },
      list: async (params: { customer: string }) => {
        if (fake.listFails) throw new Error('synthetic Stripe outage');
        return { data: fake.subs.filter((s) => s.customer === params.customer).map((s) => ({ ...s })), has_more: false };
      },
    },
  };
  return { stripeFromKey: () => stripe, getStripe: () => stripe };
});

const request = (resume: boolean) => new NextRequest('https://app.example.test/api/billing/cancel', { method: 'POST', body: JSON.stringify({ resume }) });
const family = { family_id: 'family-a' };
const sub = (id: string) => fake.subs.find((s) => s.id === id)!;

beforeEach(() => {
  fake.subs = [
    { id: 'sub_A', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false },
    { id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false },
  ];
  fake.row = { provider_ref: 'sub_A', status: 'active' };
  fake.billingCustomerRef = 'cus_a';
  fake.listFails = false; fake.updateFailsFor = new Set(); fake.updates = []; fake.syncs = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('cancelling a family that Stripe bills twice', () => {
  it('schedules every live subscription of the family to end, not only the one the row follows', async () => {
    const response = await cancel(request(false));
    expect(response.status).toBe(200);
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
    expect(fake.syncs).toBe(1);
  });

  it('finds the other one on the family\'s second Stripe customer', async () => {
    fake.subs[1].customer = 'cus_b';
    fake.billingCustomerRef = 'cus_b';
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('also looks on the customer of the subscription it cancelled', async () => {
    fake.billingCustomerRef = 'cus_other'; // the row names the customer of a racing checkout
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('does not ask Stripe again for one already set to end', async () => {
    sub('sub_B').cancel_at_period_end = true;
    expect((await cancel(request(false))).status).toBe(200);
    expect(fake.updates.map((u) => u.id)).toEqual(['sub_A']);
  });

  it('leaves alone what is not this family\'s, or has already ended', async () => {
    fake.subs.push(
      { id: 'sub_other_family', status: 'active', customer: 'cus_a', metadata: { family_id: 'family-b' }, cancel_at_period_end: false },
      { id: 'sub_ended', status: 'canceled', customer: 'cus_a', metadata: family, cancel_at_period_end: false },
    );
    expect((await cancel(request(false))).status).toBe(200);
    expect(fake.updates.map((u) => u.id).sort()).toEqual(['sub_A', 'sub_B']);
  });

  it('resuming resumes only the one the row follows', async () => {
    sub('sub_A').cancel_at_period_end = true; sub('sub_B').cancel_at_period_end = true;
    expect((await cancel(request(true))).status).toBe(200);
    expect(sub('sub_A').cancel_at_period_end).toBe(false);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('resuming touches no other subscription', async () => {
    sub('sub_A').cancel_at_period_end = true;
    expect((await cancel(request(true))).status).toBe(200);
    expect(fake.updates).toEqual([{ id: 'sub_A', cancel_at_period_end: false }]);
    expect(sub('sub_B').cancel_at_period_end).toBe(false);
  });

  it('says the cancellation is not finished when the others cannot be read, and a retry completes it', async () => {
    fake.listFails = true;
    const response = await cancel(request(false));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ providerUpdated: true });
    expect(sub('sub_B').cancel_at_period_end).toBe(false);
    fake.listFails = false;
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('says the cancellation is not finished when another one cannot be cancelled', async () => {
    fake.updateFailsFor.add('sub_B');
    const response = await cancel(request(false));
    expect(response.status).toBe(503);
    expect(fake.syncs).toBe(0);
  });

  it('cancels the one subscription of an ordinary family (control)', async () => {
    fake.subs.pop();
    const response = await cancel(request(false));
    expect(response.status).toBe(200);
    expect(fake.updates).toEqual([{ id: 'sub_A', cancel_at_period_end: true }]);
  });
});
