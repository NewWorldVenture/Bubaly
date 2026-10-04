import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A merchant's incremental authorization is checked against what the child has
 * left, and held.
 *
 * A hotel, a car rental or a fuel pump can raise an authorization it already
 * has. Stripe sends that as another issuing_authorization.request for the SAME
 * authorization, asking for the additional amount (stripe-node's
 * Issuing.Authorization.PendingRequest: "the additional amount Stripe will hold
 * if the authorization is approved"); `request_history` lists the requests it
 * has already decided.
 *
 * The handler reserved every request under the authorization id, and
 * wallet_reserve_card_auth (0155) answers "already reserved" to a live hold
 * under the key it is given, without a balance check. So an increment was
 * approved unchecked and never held: with $50 in Spend and a $40 hold, a $100
 * increment went through, Stripe held $140 against a ledger holding $40, and the
 * capture left Spend at −$90.
 *
 * Signed events go through the real /api/webhooks/money route with the real
 * handlers and wallet helpers. wallet_reserve_card_auth is emulated statement by
 * statement from 0155. The 0487 functions are absent here (the fallback); the
 * last block records what the handlers name to them, and
 * a-card-hold-follows-what-was-captured.test.ts runs an increase through an
 * emulation of them.
 */

const SECRET = 'whsec_test_incremental_authorization';
const FAMILY = 'family-1';
const WALLET = 'wallet-a';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  decided: [] as { id: string; approve: boolean }[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
// Only Stripe's approve/decline answer is faked; the signature check stays real.
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStripe: () => ({
    issuing: {
      authorizations: {
        approve: async (id: string) => { harness.decided.push({ id, approve: true }); return { id }; },
        decline: async (id: string) => { harness.decided.push({ id, approve: false }); return { id }; },
      },
    },
  }),
}));

const { POST } = await import('@/app/api/webhooks/money/route');

let db: InMemorySupabase;
let events = 0;
type RpcHandler = (args: Record<string, unknown>, db: InMemorySupabase) => unknown;

/** wallet_reserve_card_auth as 0155 writes it, statement for statement. */
const reserve: RpcHandler = (args, mem) => {
  const amount = Number(args.p_amount);
  if (!(amount > 0)) return true;
  const bucket = (mem.table('wallet_buckets') as Row[])
    .find((b) => b.family_id === args.p_family && b.child_wallet_id === args.p_child_wallet && b.kind === 'spend');
  if (!bucket) return false;
  const rows = mem.table('wallet_transactions') as Row[];
  if (rows.some((r) => r.stripe_ref === args.p_auth_id && r.type === 'card_spend' && r.status === 'processing')) return true;
  const spendable = rows
    .filter((r) => r.family_id === args.p_family && r.bucket_id === bucket.id && (r.status === 'completed' || r.status === 'processing'))
    .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
  if (amount > spendable) return false;
  rows.push({
    id: `hold-${String(args.p_auth_id)}`, family_id: args.p_family, child_wallet_id: args.p_child_wallet, bucket_id: bucket.id,
    type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: amount,
    description: args.p_description, stripe_ref: args.p_auth_id, metadata: { source: 'issuing', kind: 'hold' },
  });
  return true;
};

function store(rpc: Record<string, RpcHandler> = {}) {
  db = createInMemorySupabase({
    uniques: { stripe_webhook_events: [['stripe_event_id']], stripe_authorizations: [['stripe_authorization_id']] },
    rpc: { wallet_reserve_card_auth: reserve, ...rpc },
  });
  harness.db = db;
  harness.decided = [];
  db.seed('stripe_issuing_cards', [
    { id: 'card-row-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_child', is_frozen: false, blocked_categories: [], status: 'active' },
  ]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  db.seed('wallet_transactions', [
    // $50 in Spend, and the $40 hold the hotel's first request placed.
    { id: 'txn-topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5_000, stripe_ref: null },
    { id: 'hold-iauth_1', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 4_000, stripe_ref: 'iauth_1' },
  ]);
  db.seed('stripe_authorizations', [
    { id: 'auth-row-1', family_id: FAMILY, card_id: 'card-row-1', child_wallet_id: WALLET, stripe_authorization_id: 'iauth_1', amount_cents: 4_000, outcome: 'approved' },
  ]);
  db.seed('stripe_webhook_events', []);
  db.seed('wallet_audit_logs', []);
}

beforeEach(() => {
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const decided = (approve: boolean) => ({ approved: approve, amount: 0, created: 1_790_000_000, reason: 'webhook_approved' });

/** The hotel's n-th request on iauth_1: `prior` requests already decided. */
function request(additional: number, prior: unknown[] = [{ ...decided(true), amount: 4_000 }], over: Partial<Stripe.Issuing.Authorization> = {}): Stripe.Issuing.Authorization {
  return {
    id: 'iauth_1', object: 'issuing.authorization', status: 'pending', approved: prior.length > 0,
    amount: 4_000, currency: 'usd', card: 'ic_child', merchant_data: { name: 'Harbor Hotel', category: 'hotels_motels_and_resorts' },
    pending_request: { amount: additional, currency: 'usd', is_amount_controllable: false, merchant_amount: additional, merchant_currency: 'usd' },
    request_history: prior, transactions: [],
    ...over,
  } as unknown as Stripe.Issuing.Authorization;
}

function capture(amount: number, over: Partial<Stripe.Issuing.Transaction> = {}): Stripe.Issuing.Transaction {
  return {
    id: 'ipi_stay', object: 'issuing.transaction', amount: -amount, currency: 'usd', type: 'capture',
    card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Harbor Hotel' },
    ...over,
  } as unknown as Stripe.Issuing.Transaction;
}

/** iauth_1 closing, with `requests` requests behind it and these captures. */
function closed(requests: number, transactions: Stripe.Issuing.Transaction[], over: Partial<Stripe.Issuing.Authorization> = {}): Stripe.Issuing.Authorization {
  return request(0, Array.from({ length: requests }, () => decided(true)), {
    status: 'closed', pending_request: null, transactions, ...over,
  } as Partial<Stripe.Issuing.Authorization>);
}

async function deliver(type: 'issuing_authorization.request' | 'issuing_authorization.updated' | 'issuing_transaction.created', object: unknown, eventId = `evt_${++events}`): Promise<Response> {
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
const liveHolds = () => ledger().filter((r) => r.type === 'card_spend' && r.status === 'processing');
/** What the next authorization is decided against (0155 sums completed and processing). */
const spendableCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
const balanceCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && r.status === 'completed')
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);

describe('a merchant raising an authorization it already holds', () => {
  it('is declined when the increase is more than the child has left', async () => {
    expect((await deliver('issuing_authorization.request', request(10_000))).status).toBe(200);

    // $50 − the $40 already held leaves $10; the $100 increase does not fit.
    expect(harness.decided).toEqual([{ id: 'iauth_1', approve: false }]);
    expect(liveHolds().map((r) => r.amount_cents)).toEqual([4_000]);
    expect(spendableCents()).toBe(1_000);
  });

  it('is approved and held when it fits, so the next purchase sees it', async () => {
    await deliver('issuing_authorization.request', request(1_000));

    expect(harness.decided).toEqual([{ id: 'iauth_1', approve: true }]);
    expect(byRef('iauth_1#request-1')).toEqual([expect.objectContaining({ status: 'processing', direction: 'debit', amount_cents: 1_000 })]);
    // Approved without a hold, it still read $10.
    expect(spendableCents()).toBe(0);
  });

  it('a redelivered increase is held once', async () => {
    const increase = request(1_000);
    await deliver('issuing_authorization.request', increase, 'evt_increase');
    await deliver('issuing_authorization.request', increase, 'evt_increase');

    expect(byRef('iauth_1#request-1')).toHaveLength(1);
    expect(spendableCents()).toBe(0);
  });

  it('each later increase is a request of its own, checked on its own', async () => {
    db.table('wallet_transactions').push({ id: 'txn-topup-2', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 2_000, stripe_ref: null });
    await deliver('issuing_authorization.request', request(1_000));
    await deliver('issuing_authorization.request', request(1_500, [decided(true), decided(true)]));
    await deliver('issuing_authorization.request', request(1_000, [decided(true), decided(true), decided(true)]));

    expect(harness.decided.map((d) => d.approve)).toEqual([true, true, false]);
    expect(liveHolds().map((r) => [r.stripe_ref, r.amount_cents])).toEqual([
      ['iauth_1', 4_000], ['iauth_1#request-1', 1_000], ['iauth_1#request-2', 1_500],
    ]);
    expect(spendableCents()).toBe(500);
  });

  it('a declined increase does not count, and the next one is still checked against what is left', async () => {
    await deliver('issuing_authorization.request', request(10_000));
    await deliver('issuing_authorization.request', request(800, [decided(true), decided(false)]));

    expect(harness.decided.map((d) => d.approve)).toEqual([false, true]);
    expect(byRef('iauth_1#request-2')).toEqual([expect.objectContaining({ amount_cents: 800 })]);
    expect(spendableCents()).toBe(200);
  });

  it('a first request is held under the authorization id, as it always was', async () => {
    await deliver('issuing_authorization.request', request(700, [], { id: 'iauth_2', amount: 0, approved: false } as Partial<Stripe.Issuing.Authorization>));

    expect(harness.decided).toEqual([{ id: 'iauth_2', approve: true }]);
    expect(byRef('iauth_2')).toEqual([expect.objectContaining({ status: 'processing', amount_cents: 700 })]);
  });

  it('an increase is decided even though its audit row is refused (one row per authorization)', async () => {
    await deliver('issuing_authorization.request', request(1_000));

    expect(harness.decided).toEqual([{ id: 'iauth_1', approve: true }]);
    expect(console.error).toHaveBeenCalledWith('[money] card authorization was decided but not recorded',
      { authorizationId: 'iauth_1', outcome: 'approved' }, expect.anything());
  });
});

describe('the increase is released with the rest of the authorization (no 0487 functions)', () => {
  beforeEach(async () => {
    await deliver('issuing_authorization.request', request(1_000));
    expect(spendableCents()).toBe(0);
  });

  it('a close that lists the whole $50 captured posts it and releases both holds', async () => {
    expect((await deliver('issuing_authorization.updated', closed(2, [capture(5_000)]))).status).toBe(200);

    expect(byRef('ipi_stay')).toEqual([expect.objectContaining({ status: 'completed', amount_cents: 5_000 })]);
    expect(liveHolds()).toEqual([]);
    expect([balanceCents(), spendableCents()]).toEqual([0, 0]);
  });

  it('capture first, close second: the increase is held until the close, then released', async () => {
    await deliver('issuing_transaction.created', capture(5_000));
    // Without the 0487 functions a capture releases what it always did, the
    // authorization id's own hold; the increase waits for the close.
    expect(byRef('iauth_1#request-1')).toEqual([expect.objectContaining({ status: 'processing' })]);

    await deliver('issuing_authorization.updated', closed(2, [capture(5_000)]));

    expect(liveHolds()).toEqual([]);
    expect([balanceCents(), spendableCents()]).toEqual([0, 0]);
  });

  it('a reversed authorization releases every request it held', async () => {
    await deliver('issuing_authorization.updated', closed(2, [], { status: 'reversed' } as Partial<Stripe.Issuing.Authorization>));

    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it('with no card mirror, every request\'s hold is released by its key', async () => {
    db.table('stripe_issuing_cards').length = 0;

    await deliver('issuing_authorization.updated', closed(2, [], { status: 'expired' } as Partial<Stripe.Issuing.Authorization>));

    expect(liveHolds()).toEqual([]);
  });
});

describe('with the 0487 functions', () => {
  // Their SQL is proven on PostgreSQL by docs/audit/a-card-hold-follows-what-was-captured-check.sql:
  // every live hold of the authorization (its id, or its id then `#`) is drawn
  // down by a capture and released by the close. Here the handlers are pinned
  // to name the AUTHORIZATION to them, never a request's key.
  function recording() {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    store({
      wallet_settle_card_capture: (args) => { calls.push({ name: 'settle', args }); return { ok: true, transaction_id: 'txn-stay' }; },
      wallet_close_card_auth: (args) => { calls.push({ name: 'close', args }); return { ok: true, released_cents: 0 }; },
    });
    return calls;
  }

  it('a capture and the close each name the authorization, not a request', async () => {
    const calls = recording();
    await deliver('issuing_authorization.request', request(1_000));

    await deliver('issuing_transaction.created', capture(5_000));
    await deliver('issuing_authorization.updated', closed(2, [capture(5_000)]));

    expect(calls.map((c) => [c.name, c.args.p_auth_id])).toEqual([['settle', 'iauth_1'], ['settle', 'iauth_1'], ['close', 'iauth_1']]);
  });
});
