import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A card hold is released by what was captured, whatever order Stripe's events
 * arrive in.
 *
 * An approved authorization places a hold: a `processing` card_spend keyed by
 * the authorization id, which counts against what the child can spend next. Two
 * things released it too early:
 *
 *  1. issuing_authorization.updated with status `closed` released the whole hold
 *     at once. Stripe closes an authorization when it is captured and does not
 *     order that event before issuing_transaction.created, so the held money was
 *     spendable again before the capture debited it. A second purchase approved
 *     in that gap overdrew Spend once the first one posted.
 *  2. The first capture released the whole hold, even when it captured less than
 *     was authorized and Stripe could still capture the rest.
 *
 * Signed events go through the real /api/webhooks/money route with the real
 * handlers and wallet helpers, against an in-memory store. The partial-capture
 * remainder lives in SQL (wallet_settle_card_capture, under the spend-bucket
 * lock), so here it is pinned by the calls the handlers make; the SQL itself is
 * replayed on PostgreSQL 16 in the PR.
 */

const SECRET = 'whsec_test_card_hold_follows_capture';
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
type RpcHandler = (args: Record<string, unknown>, db: InMemorySupabase) => unknown;

function store(rpc: Record<string, RpcHandler> = {}) {
  db = createInMemorySupabase({ uniques: { stripe_webhook_events: [['stripe_event_id']] }, rpc });
  harness.db = db;
  db.seed('stripe_issuing_cards', [
    { id: 'card-row-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_child', is_frozen: false, blocked_categories: [], status: 'active' },
  ]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  db.seed('wallet_transactions', [
    // $50 in Spend, and the $20 hold the purchase's authorization reserved.
    { id: 'txn-topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5_000, stripe_ref: null },
    { id: 'txn-hold', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 2_000, stripe_ref: 'iauth_1' },
  ]);
  db.seed('stripe_webhook_events', []);
  db.seed('wallet_audit_logs', []);
}

beforeEach(() => {
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function capture(over: Partial<Stripe.Issuing.Transaction> = {}): Stripe.Issuing.Transaction {
  return {
    id: 'ipi_capture', object: 'issuing.transaction', amount: -2_000, currency: 'usd', type: 'capture',
    card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Corner Books' },
    ...over,
  } as unknown as Stripe.Issuing.Transaction;
}

function authorization(over: Partial<Stripe.Issuing.Authorization> = {}): Stripe.Issuing.Authorization {
  return {
    id: 'iauth_1', object: 'issuing.authorization', amount: 2_000, currency: 'usd', status: 'closed',
    card: 'ic_child', merchant_data: { name: 'Corner Books' }, transactions: [capture()],
    ...over,
  } as unknown as Stripe.Issuing.Authorization;
}

async function deliver(type: 'issuing_transaction.created' | 'issuing_authorization.updated', object: unknown, eventId = `evt_${++events}`): Promise<Response> {
  const payload = JSON.stringify({
    id: eventId, object: 'event', type, created: 1_790_000_000,
    api_version: '2026-05-27.dahlia', livemode: false, data: { object },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return POST(new Request('https://bubaly.test/api/webhooks/money', {
    method: 'POST', body: payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  }) as never);
}

const ledger = () => db.table('wallet_transactions') as Row[];
const byRef = (ref: string) => ledger().filter((r) => r.stripe_ref === ref);
/** What the next authorization is decided against: wallet_reserve_card_auth
 *  totals `completed` AND `processing`, so a live hold counts against Spend. */
const spendableCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);

describe('an authorization that closes before its capture is posted', () => {
  it('posts the capture it lists before releasing the hold, so the held money is never spendable twice', async () => {
    const res = await deliver('issuing_authorization.updated', authorization());

    expect(res.status).toBe(200);
    expect(byRef('ipi_capture')).toEqual([expect.objectContaining({ type: 'card_spend', status: 'completed', direction: 'debit', amount_cents: 2_000 })]);
    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ id: 'txn-hold', status: 'cancelled' })]);
    // $50 − the $20 purchase. Releasing the hold alone answered $50.
    expect(spendableCents()).toBe(3_000);
  });

  it('then the capture event changes nothing more', async () => {
    await deliver('issuing_authorization.updated', authorization());

    expect((await deliver('issuing_transaction.created', capture())).status).toBe(200);

    expect(byRef('ipi_capture')).toHaveLength(1);
    expect(spendableCents()).toBe(3_000);
  });

  it('capture first and close second ends in the same place', async () => {
    await deliver('issuing_transaction.created', capture());
    await deliver('issuing_authorization.updated', authorization());

    expect(byRef('ipi_capture')).toHaveLength(1);
    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a closed authorization with nothing captured just releases its hold', async () => {
    await deliver('issuing_authorization.updated', authorization({ transactions: [] }));

    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(spendableCents()).toBe(5_000);
  });

  it('an expired authorization that was captured late posts that capture too', async () => {
    await deliver('issuing_authorization.updated', authorization({ status: 'expired' }));

    expect(byRef('ipi_capture')).toHaveLength(1);
    expect(spendableCents()).toBe(3_000);
  });

  it('a refund listed on the authorization is left to its own event', async () => {
    const refund = capture({ id: 'ipi_refund', type: 'refund', amount: 2_000 } as Partial<Stripe.Issuing.Transaction>);
    await deliver('issuing_authorization.updated', authorization({ transactions: [capture(), refund] }));

    expect(byRef('ipi_refund')).toEqual([]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a refund with a negative amount listed on it is not settled as a capture', async () => {
    const reversal = capture({ id: 'ipi_reversal', type: 'refund', amount: -500 } as Partial<Stripe.Issuing.Transaction>);
    await deliver('issuing_authorization.updated', authorization({ transactions: [capture(), reversal] }));

    expect(byRef('ipi_reversal')).toEqual([]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a still-pending authorization keeps its hold', async () => {
    await deliver('issuing_authorization.updated', authorization({ status: 'pending', transactions: [] }));

    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ status: 'processing' })]);
    expect(spendableCents()).toBe(3_000);
  });
});

describe('a refund reversed (type refund, negative amount)', () => {
  // Money out, so it is debited, but it is not the authorization being spent:
  // it must not draw that authorization's hold down.
  const reversal = () => capture({ id: 'ipi_reversal', type: 'refund', amount: -500 } as Partial<Stripe.Issuing.Transaction>);

  it('is debited and leaves the purchase\'s hold where it was', async () => {
    expect((await deliver('issuing_transaction.created', reversal())).status).toBe(200);

    expect(byRef('ipi_reversal')).toEqual([expect.objectContaining({ type: 'card_spend', status: 'completed', amount_cents: 500 })]);
    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ status: 'processing', amount_cents: 2_000 })]);
    expect(spendableCents()).toBe(5_000 - 500 - 2_000);
  });
});

describe('with the database functions (wallet_settle_card_capture, wallet_close_card_auth)', () => {
  // The partial-capture remainder is the database's: cancel the hold and hold
  // what was not captured, in one statement under the spend-bucket lock, so a
  // crash or a concurrent close can neither free money Stripe can still take
  // nor leave a hold behind for ever. These pin what the handlers ask of it.
  function recording(settle: (args: Record<string, unknown>) => unknown = () => ({ ok: true, transaction_id: 'txn-captured' })) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    store({
      wallet_settle_card_capture: (args) => { calls.push({ name: 'settle', args }); return settle(args); },
      wallet_close_card_auth: (args) => { calls.push({ name: 'close', args }); return { ok: true, released_cents: 0 }; },
    });
    return calls;
  }

  it('a capture is settled in one call that names its authorization; the app touches no hold itself', async () => {
    const calls = recording();

    expect((await deliver('issuing_transaction.created', capture({ amount: -1_200 }))).status).toBe(200);

    expect(calls).toEqual([{ name: 'settle', args: {
      p_family: FAMILY, p_child_wallet: WALLET, p_txn_id: 'ipi_capture', p_auth_id: 'iauth_1',
      p_amount: 1_200, p_description: 'Corner Books',
    } }]);
    expect(byRef('iauth_1')).toEqual([expect.objectContaining({ status: 'processing' })]);
    expect(byRef('ipi_capture')).toEqual([]);
  });

  it('a refund reversed is settled with no authorization, so no hold is drawn down', async () => {
    const calls = recording();

    await deliver('issuing_transaction.created', capture({ id: 'ipi_reversal', type: 'refund', amount: -500 } as Partial<Stripe.Issuing.Transaction>));

    expect(calls[0]?.args).toEqual(expect.objectContaining({ p_txn_id: 'ipi_reversal', p_auth_id: null, p_amount: 500 }));
  });

  it('a capture with no authorization (a force capture) is settled with none', async () => {
    const calls = recording();

    await deliver('issuing_transaction.created', capture({ authorization: null }));

    expect(calls[0]?.args).toEqual(expect.objectContaining({ p_auth_id: null }));
  });

  it('a refusal from the database is a 500, so Stripe retries', async () => {
    recording(() => ({ ok: false, reason: 'no_spend_bucket' }));

    expect((await deliver('issuing_transaction.created', capture())).status).toBe(500);
  });

  it('a closing authorization settles each capture it lists, then closes the hold', async () => {
    const calls = recording();
    const second = capture({ id: 'ipi_capture_2', amount: -500 });

    expect((await deliver('issuing_authorization.updated', authorization({ transactions: [capture(), second] }))).status).toBe(200);

    expect(calls.map((c) => c.name)).toEqual(['settle', 'settle', 'close']);
    expect(calls.map((c) => c.args.p_txn_id ?? null)).toEqual(['ipi_capture', 'ipi_capture_2', null]);
    expect(calls[2]?.args).toEqual({ p_family: FAMILY, p_child_wallet: WALLET, p_auth_id: 'iauth_1' });
  });

  it('a capture the database refuses stops the close, so the hold is not released early', async () => {
    const calls = recording(() => ({ ok: false, reason: 'no_spend_bucket' }));

    expect((await deliver('issuing_authorization.updated', authorization())).status).toBe(500);
    expect(calls.map((c) => c.name)).toEqual(['settle']);
  });
});

describe('end to end against an emulation of the two functions', () => {
  // The SQL is proven on PostgreSQL by docs/audit/a-card-hold-follows-what-was-captured-check.sql.
  // Here a small emulation with the same contract (idempotent on the capture,
  // the live hold cancelled and the remainder re-held under `<auth>#remainder`,
  // the close releasing both) runs the handlers on the primary path, results
  // and all, rather than on the fallback.
  const live = (ref: string) => ledger().filter((r) => (r.stripe_ref === ref || r.stripe_ref === `${ref}#remainder`) && r.status === 'processing');
  function emulated() {
    store({
      wallet_settle_card_capture: (args, mem) => {
        const rows = mem.table('wallet_transactions') as Row[];
        const existing = rows.find((r) => r.stripe_ref === args.p_txn_id && r.type === 'card_spend' && r.status === 'completed');
        if (existing) return { ok: true, transaction_id: existing.id, idempotent: true, released_cents: 0, remainder_cents: 0 };
        const id = `txn-${String(args.p_txn_id)}`;
        rows.push({ id, family_id: args.p_family, child_wallet_id: args.p_child_wallet, bucket_id: 'bucket-spend', type: 'card_spend', status: 'completed', direction: 'debit', amount_cents: args.p_amount, stripe_ref: args.p_txn_id });
        let held = 0;
        if (args.p_auth_id) {
          for (const r of live(String(args.p_auth_id))) { held += Number(r.amount_cents); r.status = 'cancelled'; }
          const remainder = Math.max(held - Number(args.p_amount), 0);
          if (remainder > 0) rows.push({ id: `hold-rest-${String(args.p_txn_id)}`, family_id: args.p_family, child_wallet_id: args.p_child_wallet, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: remainder, stripe_ref: `${String(args.p_auth_id)}#remainder` });
          return { ok: true, transaction_id: id, idempotent: false, released_cents: held, remainder_cents: remainder };
        }
        return { ok: true, transaction_id: id, idempotent: false, released_cents: 0, remainder_cents: 0 };
      },
      wallet_close_card_auth: (args) => {
        let released = 0;
        for (const r of live(String(args.p_auth_id))) { released += Number(r.amount_cents); r.status = 'cancelled'; }
        return { ok: true, released_cents: released };
      },
    });
  }

  it('a partial capture keeps the rest held until the authorization closes', async () => {
    emulated();

    await deliver('issuing_transaction.created', capture({ amount: -1_200 }));
    expect(spendableCents()).toBe(5_000 - 1_200 - 800);

    await deliver('issuing_authorization.updated', authorization({ transactions: [capture({ amount: -1_200 })] }));
    expect(live('iauth_1')).toEqual([]);
    expect(spendableCents()).toBe(5_000 - 1_200);
  });

  it('a close that arrives first posts the capture, releases the hold, and the late capture changes nothing', async () => {
    emulated();

    await deliver('issuing_authorization.updated', authorization());
    expect(spendableCents()).toBe(3_000);

    await deliver('issuing_transaction.created', capture());
    expect(byRef('ipi_capture')).toHaveLength(1);
    expect(spendableCents()).toBe(3_000);
  });
});
