// M6 and M20 — the Stripe Issuing webhook, driven with signed events.
//
//   M6   issuing_transaction.created debited |amount| whatever the transaction
//        was. Stripe types it 'capture' | 'refund': a capture's amount is
//        negative, a refund's positive. So a merchant's refund on a child's
//        card was posted as a SECOND card_spend debit against the Spend bucket
//        that every later authorization is decided against. (Already tracked:
//        finalaudit.md and draft PR #925; this is the same handler change.)
//   M20  issuing_authorization.request reserved a hold, then told Stripe with
//        the deprecated approve call on the client's defaults (80s, two
//        retries) against Stripe's ~2 second window. When the call failed or
//        landed late and Stripe declined by its timeout setting, the declined
//        authorization arrived already closed in issuing_authorization.created,
//        which the route did not handle, and nothing released the hold: the
//        child's money stayed held for good.
//
// The route and the handlers are real; the database is in-memory with the
// reserve RPC modelled on 0155; Stripe's API is the one seam.
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const SECRET = 'whsec_synthetic_money_secret';
const FAMILY = 'family-1';
const WALLET = 'wallet-ava';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  approve: vi.fn(),
  decline: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db }));
vi.mock('@/lib/stripe', async (original) => ({
  ...(await original<object>()),
  getStripe: () => ({ issuing: { authorizations: { approve: harness.approve, decline: harness.decline, retrieve: harness.retrieve } } }),
}));

vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
const { POST } = await import('@/app/api/webhooks/money/route');

let db: InMemorySupabase;
let eventSeq = 0;

function deliver(type: string, object: object) {
  const body = JSON.stringify({ id: `evt_${++eventSeq}`, object: 'event', type, created: 1_760_000_000, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return POST(new NextRequest('https://app.example.test/api/webhooks/money', { method: 'POST', body, headers: { 'stripe-signature': header } }));
}

/** The child's spendable Spend balance, as wallet_reserve_card_auth counts it: completed and held rows. */
function spendable(): number {
  return db.table('wallet_transactions')
    .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
    .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
}
const hold = (authId: string) => db.table('wallet_transactions').find((r) => r.stripe_ref === authId);

const authorization = (id: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'issuing.authorization', card: 'ic_ava', amount: 0, pending_request: { amount: 2000 },
  merchant_data: { name: 'Corner Shop', category: 'grocery_stores' }, approved: false, status: 'pending', request_history: [], ...extra,
});
const transaction = (id: string, type: string, amount: number, auth: string | null) => ({
  id, object: 'issuing.transaction', card: 'ic_ava', authorization: auth, type, amount, merchant_data: { name: 'Corner Shop' },
});
/** A hold as 0155's reserve writes it. */
function heldFor(authId: string, cents: number) {
  db.seed('wallet_transactions', [{ id: `hold-${authId}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: cents, stripe_ref: authId }]);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.approve.mockReset().mockResolvedValue({});
  harness.decline.mockReset().mockResolvedValue({});
  harness.retrieve.mockReset();
  db = createInMemorySupabase({
    uniques: { stripe_webhook_events: [['stripe_event_id']] },
    rpc: {
      // 0155: an atomic sufficient-funds check that writes the hold.
      wallet_reserve_card_auth: (args, store) => {
        const balance = store.table('wallet_transactions')
          .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
          .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
        if (Number(args.p_amount) > balance) return false;
        store.seed('wallet_transactions', [{ family_id: args.p_family, child_wallet_id: args.p_child_wallet, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: args.p_amount, stripe_ref: args.p_auth_id }]);
        return true;
      },
    },
  });
  harness.db = db;
  db.seed('stripe_issuing_cards', [{ id: 'card-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_ava', is_frozen: false, blocked_categories: [], status: 'active' }]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  // $50 in Spend.
  db.seed('wallet_transactions', [{ id: 'topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5000 }]);
});

describe('M6 — a card refund gives the child the money back', () => {
  it('a $20 purchase refunded in full leaves the child where they started', async () => {
    heldFor('iauth_buy', 2000);
    expect((await deliver('issuing_transaction.created', transaction('ipi_capture', 'capture', -2000, 'iauth_buy'))).status).toBe(200);
    expect(spendable()).toBe(3000);
    expect(hold('iauth_buy')?.status).toBe('cancelled');

    expect((await deliver('issuing_transaction.created', transaction('ipi_refund', 'refund', 2000, 'iauth_buy'))).status).toBe(200);
    expect(spendable()).toBe(5000);
    const refund = db.table('wallet_transactions').find((r) => r.stripe_ref === 'ipi_refund');
    expect(refund).toMatchObject({ type: 'card_refund', direction: 'credit', status: 'completed', amount_cents: 2000, bucket_id: 'bucket-spend' });
  });

  it('a refund delivered twice is credited once', async () => {
    await deliver('issuing_transaction.created', transaction('ipi_refund', 'refund', 700, null));
    await deliver('issuing_transaction.created', transaction('ipi_refund', 'refund', 700, null));
    expect(db.table('wallet_transactions').filter((r) => r.type === 'card_refund')).toHaveLength(1);
    expect(spendable()).toBe(5700);
  });

  it('a refund reversed is debited, and leaves the purchase\'s hold for its capture', async () => {
    heldFor('iauth_open', 1500);
    expect((await deliver('issuing_transaction.created', transaction('ipi_reversal', 'refund', -500, 'iauth_open'))).status).toBe(200);
    expect(db.table('wallet_transactions').find((r) => r.stripe_ref === 'ipi_reversal')).toMatchObject({ type: 'card_spend', direction: 'debit', amount_cents: 500 });
    expect(hold('iauth_open')?.status).toBe('processing');
  });

  it('a refund handled before its capture leaves the hold in place', async () => {
    heldFor('iauth_early', 2000);
    await deliver('issuing_transaction.created', transaction('ipi_early_refund', 'refund', 2000, 'iauth_early'));
    expect(hold('iauth_early')?.status).toBe('processing');
  });

  it('a transaction type this code does not know is not guessed at: 500, nothing posted, retried', async () => {
    const before = db.table('wallet_transactions').length;
    const res = await deliver('issuing_transaction.created', transaction('ipi_unknown', 'chargeback', -900, null));
    expect(res.status).toBe(500);
    expect(db.table('wallet_transactions')).toHaveLength(before);
  });
});

describe('M20 — a hold Stripe declined is released', () => {
  it('answers Stripe inside its window: one attempt, bounded to 1.5 seconds', async () => {
    await deliver('issuing_authorization.request', authorization('iauth_fast'));
    expect(harness.approve).toHaveBeenCalledTimes(1);
    expect(harness.approve.mock.calls[0][2]).toMatchObject({ timeout: 1500, maxNetworkRetries: 0 });
    expect(hold('iauth_fast')?.status).toBe('processing');
  });

  it('an approval that did not land, for a purchase Stripe declined, releases its hold', async () => {
    harness.approve.mockRejectedValue(new Error('Request timed out'));
    harness.retrieve.mockResolvedValue(authorization('iauth_late', { approved: false, status: 'closed' }));

    await expect(deliver('issuing_authorization.request', authorization('iauth_late'))).rejects.toThrow('Stripe authorization response failed');
    expect(hold('iauth_late')?.status).toBe('cancelled');
    expect(spendable()).toBe(5000);
  });

  it('an approval that did not land, for a purchase Stripe approved, keeps its hold', async () => {
    harness.approve.mockRejectedValue(new Error('Request timed out'));
    harness.retrieve.mockResolvedValue(authorization('iauth_kept', { approved: true, status: 'pending' }));

    await expect(deliver('issuing_authorization.request', authorization('iauth_kept'))).rejects.toThrow();
    expect(hold('iauth_kept')?.status).toBe('processing');
  });

  it('an approval that did not land, for a purchase Stripe has not decided yet, keeps its hold', async () => {
    harness.approve.mockRejectedValue(new Error('socket hang up'));
    // Still inside Stripe's window: not approved YET, and not closed.
    harness.retrieve.mockResolvedValue(authorization('iauth_pending', { approved: false, status: 'pending' }));

    await expect(deliver('issuing_authorization.request', authorization('iauth_pending'))).rejects.toThrow();
    expect(hold('iauth_pending')?.status).toBe('processing');
  });

  it('when Stripe cannot be asked, the hold stays for the authorization\'s own events', async () => {
    harness.approve.mockRejectedValue(new Error('Request timed out'));
    harness.retrieve.mockRejectedValue(new Error('Stripe unreachable'));

    await expect(deliver('issuing_authorization.request', authorization('iauth_unknown'))).rejects.toThrow('Stripe authorization response failed');
    expect(hold('iauth_unknown')?.status).toBe('processing');
  });

  it('a purchase Stripe declined by its timeout setting arrives closed in .created, and its hold is released', async () => {
    heldFor('iauth_timeout', 2000);
    const res = await deliver('issuing_authorization.created', authorization('iauth_timeout', { approved: false, status: 'closed' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(hold('iauth_timeout')?.status).toBe('cancelled');
    expect(spendable()).toBe(5000);
  });

  it('an approved authorization\'s .created leaves its hold for the capture', async () => {
    heldFor('iauth_live', 2000);
    await deliver('issuing_authorization.created', authorization('iauth_live', { approved: true, status: 'pending' }));
    expect(hold('iauth_live')?.status).toBe('processing');
  });
});
