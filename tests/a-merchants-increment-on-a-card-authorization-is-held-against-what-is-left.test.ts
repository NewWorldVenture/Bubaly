// A merchant that increments a card authorization (a hotel, a pump, a
// restaurant) sends Stripe a further `issuing_authorization.request` on the SAME
// authorization, whose `pending_request.amount` is the ADDITIONAL amount to hold
// (node_modules/stripe Issuing/Authorizations.d.ts, PendingRequest.amount), and
// `request_history` lists the requests already decided.
//
// The webhook reserved every request under the authorization's own id, and
// 0155's wallet_reserve_card_auth answers `true` for an id that already has a
// live hold ("Idempotency: a hold already exists for this authorization") without
// summing or holding anything. So the increment was approved against no hold at
// all: $10 in Spend, an $8 hold, an $8 increment approved, and the $16 capture
// took the child's immutable Spend ledger to -$6, every later decision made
// against a negative balance.
//
// Each increment now holds under a key of its own (`<authorization id>-<n>`,
// n the requests already decided), so the RPC decides it against what the
// earlier holds left, and the capture or the authorization's end releases them
// all.
//
// Each request's decision is recorded under that same key. The table is
// UNIQUE (stripe_authorization_id), and an increment recorded under the
// authorization's own id was refused, so a declined increment never reached
// the parents (review item CMS-REV-3).
//
// When our approval of an increment does not land, Stripe decides it by its
// timeout setting while the authorization goes on, pending on its earlier
// amounts. An increment Stripe declined that way has its own hold released,
// and only that one; before, it stayed held until the capture or the close,
// days for a hotel (review item CMS-REV-4).
//
// Finding N4 (child-money-scope). The route and the handlers are real; the
// database is in-memory, and the reserve RPC is modelled on 0155 line for line,
// its idempotency shortcut included; Stripe's API is the one seam. Nothing here
// establishes the bucket lock or row-level security.
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

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
const { releaseCardHold } = await import('@/lib/wallet/server');

let db: InMemorySupabase;
let eventSeq = 0;

function deliver(type: string, object: object) {
  const body = JSON.stringify({ id: `evt_${++eventSeq}`, object: 'event', type, created: 1_760_000_000, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return POST(new NextRequest('https://app.example.test/api/webhooks/money', { method: 'POST', body, headers: { 'stripe-signature': header } }));
}

const inSpend = (r: Row) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing');
const signed = (r: Row) => (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents));
/** The child's spendable Spend balance as 0155, 0342 and 0483 count it: completed and held rows. */
const spendable = () => db.table('wallet_transactions').filter(inSpend).reduce((sum, r) => sum + signed(r), 0);
const liveHolds = () => db.table('wallet_transactions').filter((r) => r.type === 'card_spend' && r.status === 'processing');
const heldCents = () => liveHolds().reduce((sum, r) => sum + Number(r.amount_cents), 0);
/** The decisions recorded for the parents (the admin Stripe page reads these columns). */
const recorded = () => db.table('stripe_authorizations').map((r) => ({ outcome: r.outcome, decline_reason: r.decline_reason, amount_cents: r.amount_cents }));

/**
 * PostgREST's LIKE: `*` is its spelling of `%`, a backslash escapes the next
 * character, `%` is any run and `_` any one character, and case is kept.
 */
function postgrestLike(pattern: string): RegExp {
  let source = '';
  const aliased = pattern.replace(/\*/g, '%');
  for (let i = 0; i < aliased.length; i++) {
    const char = aliased[i];
    if (char === '\\' && i + 1 < aliased.length) source += aliased[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (char === '%') source += '[\\s\\S]*';
    else if (char === '_') source += '[\\s\\S]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
/**
 * The shared fake reads a `like.` pattern in an `or()` without PostgREST's
 * escape, so an `or()` of `eq.` and `like.` clauses on one column is answered
 * here, as an `in` over the values it matches when the statement is built.
 * Anything else goes to the fake as it is.
 */
function answerLikeAsPostgrest(store: InMemorySupabase) {
  const from = store.from.bind(store);
  vi.spyOn(store, 'from').mockImplementation((name: string) => {
    const query = from(name);
    const or = query.or.bind(query);
    query.or = (expression: string) => {
      const clauses = expression.split(',').map((clause) => /^(\w+)\.(eq|like)\.(.+)$/.exec(clause));
      const column = clauses[0]?.[1];
      if (!column || clauses.some((c) => !c || c[1] !== column)) return or(expression);
      const matches = (value: string) => clauses.some((c) => (c![2] === 'eq' ? value === c![3] : postgrestLike(c![3]).test(value)));
      return query.in(column, store.table(name).map((row) => row[column]).filter((value) => typeof value === 'string' && matches(value)));
    };
    return query;
  });
}

type Decided = { amount: number; approved: boolean };
/** One request on an authorization: the amount it asks to ADD, and the requests already decided. */
const request = (id: string, addCents: number, decided: Decided[] = []) => ({
  id, object: 'issuing.authorization', card: 'ic_ava', status: 'pending',
  amount: decided.filter((d) => d.approved).reduce((sum, d) => sum + d.amount, 0),
  approved: decided.some((d) => d.approved),
  pending_request: { amount: addCents, currency: 'usd', is_amount_controllable: false, merchant_amount: addCents, merchant_currency: 'usd' },
  request_history: decided.map((d) => ({ amount: d.amount, approved: d.approved, currency: 'usd', reason: d.approved ? 'webhook_approved' : 'webhook_declined' })),
  merchant_data: { name: 'Lakeside Hotel', category: 'hotels_motels_and_resorts' },
});
const closed = (id: string, decided: Decided[]) => ({ ...request(id, 0, decided), pending_request: null, status: 'closed' });
const capture = (id: string, amount: number, auth: string) => ({
  id, object: 'issuing.transaction', card: 'ic_ava', authorization: auth, type: 'capture', amount, merchant_data: { name: 'Lakeside Hotel' },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.approve.mockReset().mockResolvedValue({});
  harness.decline.mockReset().mockResolvedValue({});
  harness.retrieve.mockReset();
  db = createInMemorySupabase({
    // stripe_authorizations: UNIQUE (stripe_authorization_id), 00901_stripe_money.sql.
    uniques: { stripe_webhook_events: [['stripe_event_id']], stripe_authorizations: [['stripe_authorization_id']] },
    rpc: {
      // 0155, in order: nothing to hold approves; the spend bucket (its lock);
      // an existing live hold under this key approves without holding again;
      // the completed + processing sum; the new hold under the key it was given.
      wallet_reserve_card_auth: (args, store) => {
        if (Number(args.p_amount) <= 0) return true;
        const bucket = store.table('wallet_buckets').find((b) => b.family_id === args.p_family && b.child_wallet_id === args.p_child_wallet && b.kind === 'spend');
        if (!bucket) return false;
        if (store.table('wallet_transactions').some((r) => r.stripe_ref === args.p_auth_id && r.type === 'card_spend' && r.status === 'processing')) return true;
        const balance = store.table('wallet_transactions').filter((r) => r.family_id === args.p_family && inSpend(r)).reduce((sum, r) => sum + signed(r), 0);
        if (Number(args.p_amount) > balance) return false;
        store.seed('wallet_transactions', [{ family_id: args.p_family, child_wallet_id: args.p_child_wallet, bucket_id: bucket.id, type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: args.p_amount, stripe_ref: args.p_auth_id, description: args.p_description }]);
        return true;
      },
    },
  });
  answerLikeAsPostgrest(db);
  harness.db = db;
  db.seed('stripe_issuing_cards', [{ id: 'card-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_ava', is_frozen: false, blocked_categories: [], status: 'active' }]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  // $10 in Spend.
  db.seed('wallet_transactions', [{ id: 'topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 1000 }]);
});

/** The first request on the hotel's authorization: $8, approved and held. */
async function checkIn() {
  expect((await deliver('issuing_authorization.request', request('iauth_hotel', 800))).status).toBe(200);
  expect(harness.approve).toHaveBeenCalledTimes(1);
  expect(heldCents()).toBe(800);
  harness.approve.mockClear();
}
const FIRST: Decided[] = [{ amount: 800, approved: true }];

describe('a merchant\'s increment on a card authorization is held against what is left', () => {
  it('$10 in Spend, an $8 hold: an $8 increment on the same authorization is declined', async () => {
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 800, FIRST));

    expect(harness.decline).toHaveBeenCalledTimes(1);
    expect(harness.approve).not.toHaveBeenCalled();
    expect(heldCents()).toBe(800);
    expect(spendable()).toBe(200);
  });

  it('an increment that fits is approved and held too: $8 and $2 leave nothing to spend', async () => {
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));

    expect(harness.approve).toHaveBeenCalledTimes(1);
    expect(heldCents()).toBe(1000);
    expect(spendable()).toBe(0);
    // And the next purchase anywhere is decided against that.
    await deliver('issuing_authorization.request', request('iauth_corner_shop', 100));
    expect(harness.decline).toHaveBeenCalledTimes(1);
  });

  it('each further increment is its own hold, checked against what the earlier ones left', async () => {
    db.seed('wallet_transactions', [{ id: 'topup-2', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 500 }]);
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 400, FIRST));
    await deliver('issuing_authorization.request', request('iauth_hotel', 400, [...FIRST, { amount: 400, approved: true }]));

    expect(harness.approve).toHaveBeenCalledTimes(1);
    expect(harness.decline).toHaveBeenCalledTimes(1);
    expect(heldCents()).toBe(1200);
    expect(spendable()).toBe(300);
  });

  it('the same increment delivered twice is held once', async () => {
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));
    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));

    expect(liveHolds()).toHaveLength(2);
    expect(heldCents()).toBe(1000);
  });

  it('an increment\'s decision is recorded as a row of its own: a decline with its reason, for the parents to read', async () => {
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 800, FIRST));

    expect(recorded()).toEqual([
      { outcome: 'approved', decline_reason: null, amount_cents: 800 },
      { outcome: 'declined', decline_reason: 'insufficient_spend_balance', amount_cents: 800 },
    ]);
  });

  it('an approved increment is recorded too, and an increment delivered twice is recorded once', async () => {
    await checkIn();

    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));
    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));

    expect(recorded()).toEqual([
      { outcome: 'approved', decline_reason: null, amount_cents: 800 },
      { outcome: 'approved', decline_reason: null, amount_cents: 200 },
    ]);
  });

  it('a first request delivered twice is still held once, under the authorization\'s own id', async () => {
    await deliver('issuing_authorization.request', request('iauth_once', 300));
    await deliver('issuing_authorization.request', request('iauth_once', 300));

    expect(liveHolds()).toEqual([expect.objectContaining({ stripe_ref: 'iauth_once', amount_cents: 300 })]);
  });

  it('the capture releases every hold of the authorization, the increment\'s too', async () => {
    await checkIn();
    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));

    expect((await deliver('issuing_transaction.created', capture('ipi_hotel', -1000, 'iauth_hotel'))).status).toBe(200);

    expect(liveHolds()).toHaveLength(0);
    expect(spendable()).toBe(0);
  });

  it('an authorization that closes releases the increment\'s hold too', async () => {
    await checkIn();
    await deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST));

    await deliver('issuing_authorization.updated', closed('iauth_hotel', [...FIRST, { amount: 200, approved: true }]));

    expect(liveHolds()).toHaveLength(0);
    expect(spendable()).toBe(1000);
  });

  it('an increment Stripe declined after our approval failed to land has its own hold released, and the first hold kept', async () => {
    await checkIn();
    harness.approve.mockRejectedValueOnce(new Error('Request timed out'));
    // Stripe decided the increment by its timeout setting and declined it; the
    // authorization goes on, on the first $8.
    harness.retrieve.mockResolvedValue({ ...request('iauth_hotel', 0, [...FIRST, { amount: 200, approved: false }]), pending_request: null });

    await expect(deliver('issuing_authorization.request', request('iauth_hotel', 200, FIRST))).rejects.toThrow('Stripe authorization response failed');

    expect(liveHolds()).toEqual([expect.objectContaining({ stripe_ref: 'iauth_hotel', amount_cents: 800 })]);
    expect(spendable()).toBe(200);
  });

  it('an increment Stripe approved, or has not decided yet, keeps its hold when our approval failed to land', async () => {
    await checkIn();
    harness.approve.mockRejectedValue(new Error('Request timed out'));
    const SECOND: Decided[] = [...FIRST, { amount: 100, approved: true }];

    harness.retrieve.mockResolvedValueOnce({ ...request('iauth_hotel', 0, SECOND), pending_request: null });
    await expect(deliver('issuing_authorization.request', request('iauth_hotel', 100, FIRST))).rejects.toThrow('Stripe authorization response failed');
    // Not decided yet: the history ends before this increment, still pending.
    harness.retrieve.mockResolvedValueOnce(request('iauth_hotel', 100, SECOND));
    await expect(deliver('issuing_authorization.request', request('iauth_hotel', 100, SECOND))).rejects.toThrow('Stripe authorization response failed');

    expect(liveHolds().map((r) => [r.stripe_ref, r.amount_cents])).toEqual([['iauth_hotel', 800], ['iauth_hotel-1', 100], ['iauth_hotel-2', 100]]);
  });

  it('releasing one authorization leaves another\'s holds alone, one whose id begins with the same letters too', async () => {
    db.seed('wallet_transactions', [
      { id: 'h1', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_hotel' },
      { id: 'h2', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_hotel-1' },
      { id: 'h3', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_hotel2' },
      { id: 'h4', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_hotel2-1' },
      { id: 'h5', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_other' },
    ]);

    await releaseCardHold(db as unknown as Parameters<typeof releaseCardHold>[0], 'iauth_hotel');

    expect(liveHolds().map((r) => r.id)).toEqual(['h3', 'h4', 'h5']);
  });

  it('an authorization id is matched as text: its underscore is not a wildcard', async () => {
    db.seed('wallet_transactions', [
      { id: 'h1', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_hotel-1' },
      { id: 'h2', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth1hotel-1' },
    ]);

    await releaseCardHold(db as unknown as Parameters<typeof releaseCardHold>[0], 'iauth_hotel');

    expect(liveHolds().map((r) => r.id)).toEqual(['h2']);
  });

  it('an id that could not stand in a filter as it is releases its own hold and nothing else', async () => {
    db.seed('wallet_transactions', [
      { id: 'h1', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_x,type.eq.card_spend' },
      { id: 'h2', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_x' },
      { id: 'h3', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'processing', direction: 'debit', amount_cents: 100, stripe_ref: 'iauth_other' },
    ]);

    await releaseCardHold(db as unknown as Parameters<typeof releaseCardHold>[0], 'iauth_x,type.eq.card_spend');

    expect(liveHolds().map((r) => r.id)).toEqual(['h2', 'h3']);
  });
});
