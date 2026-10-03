import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A merchant refund on a child's card took the money out a second time.
 *
 * Stripe sends every Issuing transaction as `issuing_transaction.created`, with
 * `type: 'capture' | 'refund'` and an `amount` that is "reflected in your
 * balance": negative for a capture, positive for a refund. The handler took
 * `Math.abs(txn.amount)` and posted a `card_spend` DEBIT for anything non-zero,
 * so a $20 refund of a $20 purchase left the child $40 down instead of even.
 * `card_refund` was in the enum and the activity labels; nothing wrote it.
 *
 * These go through the real `/api/webhooks/money` route with events signed by
 * stripe-node's own test signer (no network, no Stripe account), the real
 * handlers and the real wallet helpers, against an in-memory store. Only the
 * service client and the translator are replaced.
 */

const SECRET = 'whsec_test_refund_credits_the_child';
const FAMILY = 'family-1';
const WALLET = 'wallet-a';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { POST } = await import('@/app/api/webhooks/money/route');

let db: InMemorySupabase;
let events = 0;

beforeEach(() => {
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { stripe_webhook_events: [['stripe_event_id']] } });
  harness.db = db;
  db.seed('stripe_issuing_cards', [
    { id: 'card-row-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_child', is_frozen: false, blocked_categories: [], status: 'active' },
  ]);
  db.seed('wallet_buckets', [
    { id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' },
    { id: 'bucket-save', family_id: FAMILY, child_wallet_id: WALLET, kind: 'save' },
  ]);
  db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: WALLET, split: { spend: 0, save: 100, give: 0, invest: 0 } }]);
  db.seed('wallet_transactions', [
    // $50 in Spend, and the $20 hold the purchase's authorization reserved.
    { id: 'txn-topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5_000, stripe_ref: null },
    { id: 'txn-hold', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 2_000, stripe_ref: 'iauth_1' },
  ]);
  db.seed('stripe_webhook_events', []);
  db.seed('wallet_audit_logs', []);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function issuingTransaction(over: Partial<Stripe.Issuing.Transaction>): Stripe.Issuing.Transaction {
  return {
    id: 'ipi_capture', object: 'issuing.transaction', amount: -2_000, currency: 'usd', type: 'capture',
    card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Corner Books' },
    ...over,
  } as unknown as Stripe.Issuing.Transaction;
}

async function deliver(txn: Stripe.Issuing.Transaction, eventId = `evt_${++events}`): Promise<Response> {
  const payload = JSON.stringify({
    id: eventId, object: 'event', type: 'issuing_transaction.created', created: 1_790_000_000,
    api_version: '2026-05-27.dahlia', livemode: false, data: { object: txn },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return POST(new Request('https://bubaly.test/api/webhooks/money', {
    method: 'POST', body: payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  }) as never);
}

const ledger = () => db.table('wallet_transactions') as Row[];
/** What the child can spend: completed rows in the Spend bucket, credits minus debits. */
const spendCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && r.status === 'completed')
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
const byRef = (ref: string) => ledger().filter((r) => r.stripe_ref === ref);

describe('a refund gives the money back', () => {
  it('a $20 purchase then its $20 refund leaves the child where they started', async () => {
    expect((await deliver(issuingTransaction({}))).status).toBe(200);
    expect(spendCents()).toBe(3_000);

    expect((await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 }))).status).toBe(200);

    expect(spendCents()).toBe(5_000);
  });

  it('is written as one completed card_refund credit in Spend, keyed by the refund transaction', async () => {
    await deliver(issuingTransaction({}));
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 }));

    expect(byRef('ipi_refund')).toEqual([
      expect.objectContaining({
        family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend',
        type: 'card_refund', status: 'completed', direction: 'credit', amount_cents: 2_000,
      }),
    ]);
  });

  it('goes back to Spend whatever the allocation rule says — it is the purchase undone, not new money', async () => {
    // The family's split sends every new credit to Save. A refund is not a new
    // credit: it reverses a Spend debit, so it lands where that debit was.
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 1_500, authorization: null }));

    expect(byRef('ipi_refund').map((r) => r.bucket_id)).toEqual(['bucket-spend']);
    expect(ledger().filter((r) => r.bucket_id === 'bucket-save')).toEqual([]);
  });

  it('a partial refund gives back exactly the refunded cents', async () => {
    await deliver(issuingTransaction({}));
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 750 }));

    expect(spendCents()).toBe(3_750);
  });

  it('is credited once when Stripe redelivers the same event', async () => {
    await deliver(issuingTransaction({}));
    const refund = issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 });
    expect((await deliver(refund, 'evt_refund')).status).toBe(200);
    expect((await deliver(refund, 'evt_refund')).status).toBe(200);

    expect(byRef('ipi_refund')).toHaveLength(1);
    expect(spendCents()).toBe(5_000);
  });

  it('is credited once even if the same refund transaction arrives under a second event id', async () => {
    await deliver(issuingTransaction({}));
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 }), 'evt_a');
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 }), 'evt_b');

    expect(byRef('ipi_refund')).toHaveLength(1);
    expect(spendCents()).toBe(5_000);
  });

  it('is in the wallet audit trail as a refund', async () => {
    await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000 }));

    expect(db.table('wallet_audit_logs')).toEqual([
      expect.objectContaining({ family_id: FAMILY, action: 'card_refund', entity_id: WALLET }),
    ]);
  });
});

describe('a purchase is still a purchase', () => {
  it('a capture is one completed card_spend debit and releases its hold', async () => {
    expect((await deliver(issuingTransaction({}))).status).toBe(200);

    expect(byRef('ipi_capture')).toEqual([
      expect.objectContaining({ type: 'card_spend', status: 'completed', direction: 'debit', amount_cents: 2_000, bucket_id: 'bucket-spend' }),
    ]);
    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ id: 'txn-hold', status: 'cancelled' })]);
    expect(spendCents()).toBe(3_000);
  });

  it('a zero-amount transaction writes nothing and is acknowledged', async () => {
    expect((await deliver(issuingTransaction({ id: 'ipi_zero', amount: 0 }))).status).toBe(200);

    expect(byRef('ipi_zero')).toEqual([]);
  });

  it('a refund whose duplicate check cannot be read is not credited blind — it fails so Stripe retries', async () => {
    const from = db.from.bind(db);
    (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
      const builder = from(name) as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (name !== 'wallet_transactions') return builder;
      let inserting = false;
      const insert = builder.insert.bind(builder);
      const select = builder.select.bind(builder);
      builder.insert = (...args: unknown[]) => { inserting = true; return insert(...args); };
      builder.select = (...args: unknown[]) => {
        if (inserting) return select(...args);
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } }) };
        return chain;
      };
      return builder;
    };

    const res = await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000, authorization: null }));

    expect(res.status).toBe(500);
    expect(byRef('ipi_refund')).toEqual([]);
  });

  it('a refund on a card we do not know fails loudly so Stripe retries, and writes nothing', async () => {
    const res = await deliver(issuingTransaction({ id: 'ipi_refund', type: 'refund', amount: 2_000, card: 'ic_unknown' }));

    expect(res.status).toBe(500);
    expect(byRef('ipi_refund')).toEqual([]);
    expect(spendCents()).toBe(5_000);
  });
});
