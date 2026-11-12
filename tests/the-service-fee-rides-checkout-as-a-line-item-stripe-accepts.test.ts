// LIBRARY-2331788E1B51: the Bubaly service fee was spread into
// `subscription_data.add_invoice_items` of a Checkout Session. Checkout has no
// such parameter (it exists on Subscriptions, Subscription Schedules and
// Invoices), and the conditional spread hid it from the type checker. With the
// fee on and a fee Price saved, Stripe refuses the whole create as an unknown
// parameter, so nobody could subscribe.
//
// A subscription-mode Checkout takes a one-time Price as a second `line_items`
// entry and bills it on the first invoice only. These cases drive the real
// helper against a scripted Stripe and check the request against the PINNED
// stripe package's own definitions, so the shape is Stripe's and not a mock's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { at } from './helpers/source-order';

vi.mock('server-only', () => ({}));

import { createSubscriptionCheckout } from '@/lib/billing/subscription-checkout';

type Params = Record<string, unknown> & { line_items: { price: string; quantity: number }[]; subscription_data: Record<string, unknown> };
type Admin = Parameters<typeof createSubscriptionCheckout>[1];

const FEE_ON = { enabled: true, service_fee_cents: 90, service_fee_price_id: 'price_service_fee' };
const NOW = new Date('2026-11-11T12:00:00Z');

function harness(tracked: { session_id: string; plan: string }[] = []) {
  const created: { params: Params; options: { idempotencyKey?: string } }[] = [];
  const expired: string[] = [];
  const sessions: Record<string, { id: string; status: string; url: string; line_items: { has_more: boolean; data: { price: { id: string } }[] } }> = {};
  const hold = (id: string, prices: string[]) => {
    sessions[id] = { id, status: 'open', url: `https://checkout.example.test/${id}`, line_items: { has_more: false, data: prices.map((p) => ({ price: { id: p } })) } };
    return sessions[id];
  };
  const stripe = { checkout: { sessions: {
    create: async (params: Params, options: { idempotencyKey?: string }) => {
      created.push({ params, options });
      return hold(`cs-${created.length}`, params.line_items.map((li) => li.price));
    },
    retrieve: async (id: string) => sessions[id],
    expire: async (id: string) => { expired.push(id); sessions[id].status = 'expired'; return sessions[id]; },
  } } } as unknown as Stripe;
  const rows = [...tracked];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'order']) builder[m] = () => builder;
  builder.limit = async () => ({ data: rows, error: null });
  const admin = { from: () => builder } as unknown as Admin;
  const start = (settings: typeof FEE_ON | null, priceId = 'price_plus_monthly') => createSubscriptionCheckout(stripe, admin, {
    familyId: 'family-a', customerId: 'cus-a', priceId, plan: 'plus_monthly', origin: 'https://app.example.test', settings, now: NOW,
  });
  return { created, expired, hold, rows, start };
}

/** The optional fields of one interface in the pinned stripe definitions. */
function pinnedFields(namespace: string, name: string): string[] {
  const source = readFileSync(join(process.cwd(), 'node_modules/stripe/esm/resources/Checkout/Sessions.d.ts'), 'utf8');
  const scoped = source.slice(at(source, `namespace ${namespace} {`));
  const open = `        interface ${name} {\n`;
  const body = scoped.slice(at(scoped, open) + open.length);
  const block = body.slice(0, at(body, '\n        }\n'));
  return [...block.matchAll(/^ {12}([a-z_]+)\??:/gm)].map((m) => m[1]);
}

describe('the service fee rides a subscription Checkout as a line item Stripe accepts', () => {
  it('the pinned stripe package has no add_invoice_items on a Checkout Session, and does take a price line item', () => {
    const subscriptionData = pinnedFields('SessionCreateParams', 'SubscriptionData');
    expect(subscriptionData).toContain('metadata');
    expect(subscriptionData).not.toContain('add_invoice_items');
    expect(pinnedFields('SessionCreateParams', 'LineItem')).toEqual(expect.arrayContaining(['price', 'quantity']));
  });

  it('sends only parameters Checkout defines under subscription_data', async () => {
    const h = harness();
    await h.start(FEE_ON);
    expect(h.created).toHaveLength(1);
    const allowed = pinnedFields('SessionCreateParams', 'SubscriptionData');
    for (const key of Object.keys(h.created[0].params.subscription_data)) expect(allowed).toContain(key);
    expect(h.created[0].params.subscription_data).toEqual({ metadata: { family_id: 'family-a' } });
  });

  it('adds the fee Price as a second, one-off line after the recurring plan', async () => {
    const h = harness();
    await h.start(FEE_ON);
    expect(h.created[0].params.mode).toBe('subscription');
    expect(h.created[0].params.line_items).toEqual([
      { price: 'price_plus_monthly', quantity: 1 },
      { price: 'price_service_fee', quantity: 1 },
    ]);
  });

  it('sends the plan alone when the fee is off or has no Price saved', async () => {
    for (const settings of [null, { ...FEE_ON, enabled: false }, { ...FEE_ON, service_fee_price_id: '' }]) {
      const h = harness();
      await h.start(settings);
      expect(h.created[0].params.line_items).toEqual([{ price: 'price_plus_monthly', quantity: 1 }]);
      expect(h.created[0].params.subscription_data).toEqual({ metadata: { family_id: 'family-a' } });
    }
  });

  it('returns the family\'s open session that already carries the plan and the fee', async () => {
    const h = harness([{ session_id: 'cs-open', plan: 'plus_monthly' }]);
    h.hold('cs-open', ['price_plus_monthly', 'price_service_fee']);
    expect(await h.start(FEE_ON)).toMatchObject({ id: 'cs-open', reused: true });
    expect(h.created).toEqual([]);
    expect(h.expired).toEqual([]);
  });

  it('does not reuse an open session whose fee line is not the one disclosed now', async () => {
    // Opened while the fee was off: paying it would skip the fee.
    const without = harness([{ session_id: 'cs-no-fee', plan: 'plus_monthly' }]);
    without.hold('cs-no-fee', ['price_plus_monthly']);
    expect(await without.start(FEE_ON)).toMatchObject({ reused: false });
    expect(without.expired).toEqual(['cs-no-fee']);

    // Opened while the fee was on: paying it would charge a fee no longer shown.
    const withFee = harness([{ session_id: 'cs-fee', plan: 'plus_monthly' }]);
    withFee.hold('cs-fee', ['price_plus_monthly', 'price_service_fee']);
    expect(await withFee.start(null)).toMatchObject({ reused: false });
    expect(withFee.expired).toEqual(['cs-fee']);
    expect(withFee.created[0].params.line_items).toEqual([{ price: 'price_plus_monthly', quantity: 1 }]);
  });

  it('a fee switched on inside the idempotency window is a different create, not a replay', async () => {
    const off = harness(); await off.start(null);
    const on = harness(); await on.start(FEE_ON);
    expect(typeof off.created[0].options.idempotencyKey).toBe('string');
    expect(on.created[0].options.idempotencyKey).not.toBe(off.created[0].options.idempotencyKey);
  });
});
