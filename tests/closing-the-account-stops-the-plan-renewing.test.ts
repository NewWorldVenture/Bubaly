// Closing a family account stops its paid plan renewing.
//
// closeAccountAction set families.closed_at and nothing else. computeEntitlement
// then locks the family out entirely (lib/server/entitlement.ts), but the Stripe
// subscription was untouched: it renewed and charged the family every period
// for an account they could not use, after a card that said "Take a break
// anytime" and nothing about billing. Closing now schedules every live
// subscription of the family to end first, and stays open, saying so, when
// Stripe cannot be asked. Reopening does not restart billing; the billing page's
// "Resume plan" is the family's own choice.
//
// Stripe is an in-memory fake; ids are synthetic.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  billingCustomerRef: null as string | null,
  key: 'sk_test_synthetic' as string | null,
  subs: [] as { id: string; status: string; customer: string; metadata: Record<string, string>; cancel_at_period_end: boolean }[],
  updateFails: false,
  updateFailsFor: new Set<string>(),
  syncs: 0,
  readFails: false,
  stripeCalls: 0,
  updates: 0,
  closed: false,
  reopened: false,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-a' },
    active: { role: 'parent', familyId: 'family-a', family: { name: 'Synthetic family' } },
  }),
}));
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => ({}), effectiveSecretKey: () => fake.key }));
vi.mock('@/lib/supabase/server', () => {
  const db = {
    from: (table: string) => {
      const builder = {
        select: () => builder, eq: () => builder,
        maybeSingle: async () => {
          if (table === 'subscriptions') return fake.readFails ? { data: null, error: { message: 'synthetic read failure' } } : { data: fake.row, error: null };
          if (table === 'billing_customers') return { data: fake.billingCustomerRef ? { customer_ref: fake.billingCustomerRef } : null, error: null };
          return { data: null, error: null };
        },
        update: (value: Record<string, unknown>) => {
          const chain = {
            eq: () => chain,
            select: async () => {
              if (table === 'families') {
                if (value.closed_at) fake.closed = true; else fake.reopened = true;
              }
              if (table === 'subscriptions') fake.syncs += 1;
              return { data: [{ id: 'row' }], error: null };
            },
          };
          return chain;
        },
      };
      return builder;
    },
  };
  return { createServiceClient: () => db, createServer: async () => db };
});
vi.mock('@/lib/stripe', () => {
  const stripe = {
    subscriptions: {
      update: async (id: string, params: { cancel_at_period_end: boolean }) => {
        fake.stripeCalls += 1;
        fake.updates += 1;
        if (fake.updateFails || fake.updateFailsFor.has(id)) throw new Error('synthetic Stripe outage');
        const s = fake.subs.find((x) => x.id === id)!;
        s.cancel_at_period_end = params.cancel_at_period_end;
        return { ...s };
      },
      list: async (params: { customer: string }) => {
        fake.stripeCalls += 1;
        return { data: fake.subs.filter((s) => s.customer === params.customer).map((s) => ({ ...s })), has_more: false };
      },
    },
  };
  return { stripeFromKey: () => stripe, getStripe: () => stripe };
});

const { closeAccountAction, reopenAccountAction } = await import('@/app/(app)/account/actions');
const family = { family_id: 'family-a' };
const sub = (id: string) => fake.subs.find((s) => s.id === id)!;

beforeEach(() => {
  fake.row = { plan: 'plus', status: 'active', provider_ref: 'sub_A', cancel_at_period_end: false };
  fake.billingCustomerRef = 'cus_a';
  fake.key = 'sk_test_synthetic';
  fake.subs = [{ id: 'sub_A', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false }];
  fake.updateFails = false; fake.updateFailsFor = new Set(); fake.syncs = 0; fake.readFails = false; fake.stripeCalls = 0; fake.updates = 0; fake.closed = false; fake.reopened = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('closing a family that pays for a plan', () => {
  it('stops the plan renewing, then closes', async () => {
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
    expect(fake.closed).toBe(true);
    expect(fake.syncs, 'the family\'s row says the plan is ending too').toBe(1);
  });

  it('finds another subscription on the family\'s second Stripe customer', async () => {
    fake.subs.push({ id: 'sub_B', status: 'active', customer: 'cus_b', metadata: family, cancel_at_period_end: false });
    fake.billingCustomerRef = 'cus_b';
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('also looks on the customer of the plan it stopped', async () => {
    fake.subs.push({ id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false });
    fake.billingCustomerRef = 'cus_other';
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('stays open when another subscription cannot be stopped', async () => {
    fake.subs.push({ id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false });
    fake.updateFailsFor.add('sub_B');
    expect(await closeAccountAction()).toEqual({ ok: false, error: 'account.couldNotStopThePlanRenewing' });
    expect(fake.closed).toBe(false);
  });

  it('stops a duplicate still billing a family whose followed plan has ended', async () => {
    fake.row = { plan: 'plus', status: 'canceled', provider_ref: 'sub_A', cancel_at_period_end: false };
    sub('sub_A').status = 'canceled';
    fake.subs.push({ id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false });
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
    expect(fake.closed).toBe(true);
  });

  it('stops every subscription that bills the family, not only the one the row follows', async () => {
    fake.subs.push({ id: 'sub_B', status: 'active', customer: 'cus_a', metadata: family, cancel_at_period_end: false });
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
    expect(sub('sub_B').cancel_at_period_end).toBe(true);
  });

  it('stays open, and says so, when Stripe cannot stop the renewal', async () => {
    fake.updateFails = true;
    expect(await closeAccountAction()).toEqual({ ok: false, error: 'account.couldNotStopThePlanRenewing' });
    expect(fake.closed).toBe(false);
  });

  it('stays open when the family\'s billing cannot be read', async () => {
    fake.readFails = true;
    expect(await closeAccountAction()).toEqual({ ok: false, error: 'account.couldNotStopThePlanRenewing' });
    expect(fake.closed).toBe(false);
  });

  it('stays open when the family is billed but no Stripe key is configured to stop it', async () => {
    fake.key = null;
    expect(await closeAccountAction()).toEqual({ ok: false, error: 'account.couldNotStopThePlanRenewing' });
    expect(fake.closed).toBe(false);
  });

  it('does not trust a row that says the plan is already ending: Stripe may have it renewing', async () => {
    // A resume whose local sync failed, or a renewal turned back on in the portal.
    fake.row = { ...fake.row, cancel_at_period_end: true };
    sub('sub_A').cancel_at_period_end = false;
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
    expect(fake.closed).toBe(true);
  });
});

describe('closing a family that pays for nothing (control)', () => {
  it('closes without asking Stripe', async () => {
    fake.row = { plan: 'free', status: 'active', provider_ref: null, cancel_at_period_end: false };
    fake.billingCustomerRef = null;
    fake.key = null;
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(fake.closed).toBe(true);
    expect(fake.stripeCalls).toBe(0);
  });

  it('closes a family whose only subscription has ended, even with no Stripe key configured', async () => {
    fake.row = { plan: 'plus', status: 'canceled', provider_ref: 'sub_A', cancel_at_period_end: false };
    fake.key = null;
    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(fake.closed).toBe(true);
  });

  it('reopening does not restart billing', async () => {
    sub('sub_A').cancel_at_period_end = true;
    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(fake.reopened).toBe(true);
    expect(fake.stripeCalls).toBe(0);
    expect(sub('sub_A').cancel_at_period_end).toBe(true);
  });
});
