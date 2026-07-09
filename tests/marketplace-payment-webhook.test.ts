import { describe, it, expect } from 'vitest';
import {
  paymentStatusFromEvent, orderTargetForPayment, handleMarketplacePayment,
} from '@/lib/marketplace/payment-webhook';

describe('pure mappers', () => {
  it('maps payment_intent events to statuses', () => {
    expect(paymentStatusFromEvent('payment_intent.succeeded')).toBe('succeeded');
    expect(paymentStatusFromEvent('payment_intent.payment_failed')).toBe('failed');
    expect(paymentStatusFromEvent('payment_intent.canceled')).toBe('canceled');
    expect(paymentStatusFromEvent('charge.refunded')).toBeNull();
  });
  it('maps a payment outcome to an order target', () => {
    expect(orderTargetForPayment('succeeded')).toBe('sold');
    expect(orderTargetForPayment('failed')).toBe('canceled');
    expect(orderTargetForPayment('canceled')).toBe('canceled');
  });
});

// Stateful fake: reads return canned rows; updates are captured.
function makeFake(rows: Record<string, unknown>) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const db = {
    updates,
    from(table: string) {
      let mode: 'read' | 'update' = 'read';
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => { mode = 'update'; patch = p; return b; },
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: rows[table] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) => {
          if (mode === 'update') updates.push({ table, patch });
          return resolve({ error: null });
        },
      };
      return b;
    },
  };
  return db;
}

const intent = { id: 'pi_123' } as never;
const asDb = (db: ReturnType<typeof makeFake>) => db as never;

describe('handleMarketplacePayment', () => {
  it('succeeded → payment succeeded + order sold', async () => {
    const db = makeFake({
      marketplace_payments: { id: 'pay1', order_id: 'o1', status: 'pending' },
      marketplace_orders: { status: 'pending' },
    });
    await handleMarketplacePayment(asDb(db), intent, 'payment_intent.succeeded');
    expect(db.updates).toEqual([
      { table: 'marketplace_payments', patch: { status: 'succeeded' } },
      { table: 'marketplace_orders', patch: { status: 'sold' } },
    ]);
  });

  it('is idempotent when the payment is already in the target status', async () => {
    const db = makeFake({ marketplace_payments: { id: 'pay1', order_id: 'o1', status: 'succeeded' } });
    await handleMarketplacePayment(asDb(db), intent, 'payment_intent.succeeded');
    expect(db.updates).toEqual([]);
  });

  it('does nothing for an unknown payment or a non-payment event', async () => {
    const unknown = makeFake({ marketplace_payments: null });
    await handleMarketplacePayment(asDb(unknown), intent, 'payment_intent.succeeded');
    expect(unknown.updates).toEqual([]);

    const other = makeFake({ marketplace_payments: { id: 'pay1', order_id: 'o1', status: 'pending' } });
    await handleMarketplacePayment(asDb(other), intent, 'charge.refunded');
    expect(other.updates).toEqual([]);
  });

  it('updates the payment but NOT an order the state machine blocks', async () => {
    const db = makeFake({
      marketplace_payments: { id: 'pay1', order_id: 'o1', status: 'pending' },
      marketplace_orders: { status: 'refunded' }, // terminal — cannot go to sold
    });
    await handleMarketplacePayment(asDb(db), intent, 'payment_intent.succeeded');
    expect(db.updates).toEqual([{ table: 'marketplace_payments', patch: { status: 'succeeded' } }]);
  });
});
