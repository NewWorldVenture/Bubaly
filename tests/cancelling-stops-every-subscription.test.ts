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
  billingReadFails: false,
  goneCustomers: new Set<string>(),
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
          if (table === 'billing_customers') return fake.billingReadFails ? { data: null, error: { message: 'synthetic read failure' } } : { data: { customer_ref: fake.billingCustomerRef }, error: null };
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
      retrieve: async (id: string) => ({ ...fake.subs.find((x) => x.id === id)! }),
      list: async (params: { customer: string }) => {
        if (fake.listFails) throw new Error('synthetic Stripe outage');
        if (fake.goneCustomers.has(params.customer)) throw Object.assign(new Error('No such customer'), { code: 'resource_missing' });
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
  fake.listFails = false; fake.billingReadFails = false; fake.goneCustomers = new Set(); fake.updateFailsFor = new Set(); fake.updates = []; fake.syncs = 0;
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

  it('changes nothing the family sees when the others cannot be read, so pressing Cancel again finishes it', async () => {
    fake.listFails = true;
    const response = await cancel(request(false));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'cancel.subscriptionStatusIsTemporarilyUnavailable' });
    expect(sub('sub_A').cancel_at_period_end).toBe(false);
    expect(sub('sub_B').cancel_at_period_end).toBe(false);
    expect(fake.syncs).toBe(0);
    fake.listFails = false;
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('changes nothing the family sees when another one cannot be cancelled', async () => {
    fake.updateFailsFor.add('sub_B');
    const response = await cancel(request(false));
    expect(response.status).toBe(503);
    expect(sub('sub_A').cancel_at_period_end).toBe(false);
    expect(fake.syncs).toBe(0);
  });

  it('changes nothing when the family\'s billing customer cannot be read', async () => {
    fake.billingReadFails = true;
    expect((await cancel(request(false))).status).toBe(503);
    expect(fake.updates).toEqual([]);
  });

  it('reads a customer Stripe no longer has as billing nobody', async () => {
    fake.billingCustomerRef = 'cus_gone';
    fake.goneCustomers.add('cus_gone');
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it.each(['trialing', 'past_due'])('stops another subscription that is %s', async (status) => {
    sub('sub_B').status = status;
    expect((await cancel(request(false))).status).toBe(200);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('cancels the one subscription of an ordinary family (control)', async () => {
    fake.subs.pop();
    const response = await cancel(request(false));
    expect(response.status).toBe(200);
    expect(fake.updates).toEqual([{ id: 'sub_A', cancel_at_period_end: true }]);
  });
});
