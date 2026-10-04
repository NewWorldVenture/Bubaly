import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A hold for a purchase Stripe declined on our behalf is released.
 *
 * If Stripe does not have our decision within 2 seconds, it approves or declines
 * the authorization by the account's timeout setting and says so only in
 * `issuing_authorization.created`, with `request_history.reason` =
 * `webhook_timeout` (Stripe docs, "Issuing real-time authorizations").
 * handleAuthorizationRequest reserves the hold FIRST and then calls Stripe's
 * approve API, so a slow run had already committed the hold when the approve
 * call failed. The route ignored `.created`, and nothing else released it: the
 * child's money stayed held for good.
 *
 * Handling `.created` alone would not do, because it can be handled before the
 * late hold commits. So when the approve call fails the handler also asks Stripe
 * what it decided for THIS request, and releases this request's hold only if
 * Stripe declined it. Approved by the timeout setting, or unknown, it stays:
 * money held, never money freed.
 *
 * Signed events go through the real /api/webhooks/money route; Stripe's API is
 * faked, and wallet_reserve_card_auth is emulated statement by statement from 0155.
 */

const SECRET = 'whsec_test_stripe_declined_for_us';
const FAMILY = 'family-1';
const WALLET = 'wallet-a';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as string[],
  approveError: null as Error | null,
  declineError: null as Error | null,
  retrieved: null as unknown,
  retrieveError: null as Error | null,
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStripe: () => ({
    issuing: {
      authorizations: {
        approve: async (id: string) => { harness.calls.push(`approve ${id}`); if (harness.approveError) throw harness.approveError; return { id }; },
        decline: async (id: string) => { harness.calls.push(`decline ${id}`); if (harness.declineError) throw harness.declineError; return { id }; },
        retrieve: async (id: string) => { harness.calls.push(`retrieve ${id}`); if (harness.retrieveError) throw harness.retrieveError; return harness.retrieved; },
      },
    },
  }),
}));

const { POST } = await import('@/app/api/webhooks/money/route');
const { handleAuthorizationRequest } = await import('@/lib/stripe/webhook');

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
  db.seed('stripe_issuing_cards', [
    { id: 'card-row-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_child', is_frozen: false, blocked_categories: [], status: 'active' },
  ]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  db.seed('wallet_transactions', [
    { id: 'txn-topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5_000, stripe_ref: null },
  ]);
  db.seed('stripe_authorizations', []);
  db.seed('stripe_webhook_events', []);
  db.seed('wallet_audit_logs', []);
}

beforeEach(() => {
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.calls = [];
  harness.approveError = null;
  harness.declineError = null;
  harness.retrieved = null;
  harness.retrieveError = null;
  store();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Decided = { approved: boolean; amount: number; reason: string };
const decided = (approved: boolean, amount: number, reason = approved ? 'webhook_approved' : 'webhook_timeout'): Decided => ({ approved, amount, reason });

function authorization(over: Record<string, unknown> = {}): Stripe.Issuing.Authorization {
  return {
    id: 'iauth_1', object: 'issuing.authorization', status: 'pending', approved: false, amount: 0, currency: 'usd',
    card: 'ic_child', merchant_data: { name: 'Corner Books', category: 'book_stores' },
    pending_request: { amount: 2_000, currency: 'usd', is_amount_controllable: false, merchant_amount: 2_000, merchant_currency: 'usd' },
    request_history: [], transactions: [],
    ...over,
  } as unknown as Stripe.Issuing.Authorization;
}

async function deliver(type: string, object: unknown, eventId = `evt_${++events}`): Promise<Response> {
  const payload = JSON.stringify({
    id: eventId, object: 'event', type, created: 1_790_000_000,
    api_version: '2026-05-27.dahlia', livemode: false, data: { object },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return POST(new Request('https://bubaly.test/api/webhooks/money', {
    method: 'POST', body: payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  }) as never);
}

/** The status Stripe sees. The route lets a handler error out of the `.request`
 *  branch, and Next answers an uncaught route error 500. */
const answer = (pending: Promise<Response>) => pending.then((res) => res.status, () => 500);

const ledger = () => db.table('wallet_transactions') as Row[];
const liveHolds = () => ledger().filter((r) => r.type === 'card_spend' && r.status === 'processing').map((r) => [r.stripe_ref, r.amount_cents]);
const spendableCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
const placeHold = (ref: string, cents: number) => ledger().push({
  id: `hold-${ref}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend',
  status: 'processing', direction: 'debit', amount_cents: cents, stripe_ref: ref, metadata: { source: 'issuing', kind: 'hold' },
});

describe('issuing_authorization.created, where Stripe reports a decision it made itself', () => {
  const declinedClosed = () => authorization({ status: 'closed', approved: false, pending_request: null, request_history: [decided(false, 2_000)] });

  it('a purchase Stripe declined on timeout releases the hold our late reserve left', async () => {
    placeHold('iauth_1', 2_000);

    const res = await deliver('issuing_authorization.created', declinedClosed());

    expect(res.status).toBe(200);
    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it('an approved, still-pending authorization keeps its hold', async () => {
    placeHold('iauth_1', 2_000);

    const res = await deliver('issuing_authorization.created', authorization({
      status: 'pending', approved: true, amount: 2_000, pending_request: null, request_history: [decided(true, 2_000)],
    }));

    expect(res.status).toBe(200);
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it.each([
    ['.created first', ['issuing_authorization.created', 'issuing_authorization.updated']],
    ['.updated first', ['issuing_authorization.updated', 'issuing_authorization.created']],
  ])('.created and .updated for the same close release the hold once (%s)', async (_order, types) => {
    placeHold('iauth_1', 2_000);

    for (const type of types) expect((await deliver(type, declinedClosed())).status).toBe(200);

    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it('with the 0487 functions, a closed .created goes through wallet_close_card_auth for the authorization', async () => {
    const closes: unknown[] = [];
    store({ wallet_close_card_auth: (args) => { closes.push(args); return { ok: true, released_cents: 0 }; } });

    expect((await deliver('issuing_authorization.created', declinedClosed())).status).toBe(200);

    expect(closes).toEqual([{ p_family: FAMILY, p_child_wallet: WALLET, p_auth_id: 'iauth_1' }]);
  });

});

describe('issuing_authorization.updated on an authorization still pending', () => {
  const pending = (history: Decided[]) => authorization({ status: 'pending', approved: true, amount: 2_000, pending_request: null, request_history: history });

  it('releases the hold of an increase Stripe declined, and keeps the purchase it raised', async () => {
    placeHold('iauth_1', 2_000);
    placeHold('iauth_1#request-1', 1_000);

    await deliver('issuing_authorization.updated', pending([decided(true, 2_000), decided(false, 1_000)]));

    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a decline the card network overrode (network_fallback) waits for the close, which releases it', async () => {
    // Stripe: when the network approved what Stripe declined, it may still be captured.
    placeHold('iauth_1', 2_000);
    placeHold('iauth_1#request-1', 1_000);
    placeHold('iauth_1#request-2', 500);
    const history = [decided(true, 2_000), decided(false, 1_000), decided(false, 500, 'network_fallback')];

    await deliver('issuing_authorization.updated', pending(history));
    expect(liveHolds()).toEqual([['iauth_1', 2_000], ['iauth_1#request-2', 500]]);

    await deliver('issuing_authorization.updated', authorization({ status: 'closed', approved: true, amount: 2_000, pending_request: null, request_history: history }));
    expect(liveHolds()).toEqual([]);
  });

  it('a declined entry whose amount is not the hold\'s is not trusted', async () => {
    placeHold('iauth_1', 2_000);
    placeHold('iauth_1#request-1', 1_000);

    await deliver('issuing_authorization.updated', pending([decided(true, 2_000), decided(false, 999)]));

    expect(liveHolds()).toEqual([['iauth_1', 2_000], ['iauth_1#request-1', 1_000]]);
  });
});

describe('our approve call fails after the hold is reserved', () => {
  beforeEach(() => { harness.approveError = new Error('This authorization is no longer pending.'); });
  const increase = (prior: Decided[] = [decided(true, 2_000)]) => authorization({
    approved: true, amount: 2_000, request_history: prior,
    pending_request: { amount: 1_000, currency: 'usd', is_amount_controllable: false, merchant_amount: 1_000, merchant_currency: 'usd' },
  });
  const statuses = (ref: string) => ledger().filter((r) => r.stripe_ref === ref).map((r) => r.status);

  it('Stripe declined the purchase (timeout) and closed it: its hold is released, and the answer is still 500', async () => {
    harness.retrieved = authorization({ status: 'closed', approved: false, pending_request: null, request_history: [decided(false, 2_000)] });

    const status = await answer(deliver('issuing_authorization.request', authorization()));

    expect(status).toBe(500);
    expect(harness.calls).toEqual(['approve iauth_1', 'retrieve iauth_1']);
    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it('a declined increase releases only the increase, never the purchase it raised', async () => {
    placeHold('iauth_1', 2_000);
    harness.retrieved = authorization({
      status: 'pending', approved: true, amount: 2_000, pending_request: null,
      request_history: [decided(true, 2_000), decided(false, 1_000)],
    });

    expect(await answer(deliver('issuing_authorization.request', increase()))).toBe(500);

    expect(harness.calls).toEqual(['approve iauth_1', 'retrieve iauth_1']);
    expect(statuses('iauth_1#request-1')).toEqual(['cancelled']);
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a closed authorization with a capture listed is settled and closed, as its own event would', async () => {
    harness.retrieved = authorization({
      status: 'closed', approved: true, amount: 2_000, pending_request: null, request_history: [decided(true, 2_000, 'webhook_timeout')],
      transactions: [{ id: 'ipi_late', object: 'issuing.transaction', type: 'capture', amount: -2_000, card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Corner Books' } }],
    });

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(ledger().filter((r) => r.stripe_ref === 'ipi_late')).toEqual([expect.objectContaining({ status: 'completed', direction: 'debit', amount_cents: 2_000 })]);
    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(3_000);
  });

  it('a release that fails never replaces the error Stripe\'s answer is about', async () => {
    store({ wallet_settle_card_capture: () => { throw new Error('the settle failed'); } });
    harness.retrieved = authorization({
      status: 'closed', approved: true, amount: 2_000, pending_request: null, request_history: [decided(true, 2_000, 'webhook_timeout')],
      transactions: [{ id: 'ipi_late', object: 'issuing.transaction', type: 'capture', amount: -2_000, card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Corner Books' } }],
    });

    await expect(handleAuthorizationRequest(db as never, authorization(), undefined)).rejects.toThrow('Stripe authorization response failed');

    // The close never ran, so the hold stays for the authorization's own events.
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('an authorization Stripe has since reversed is closed whole, as its own event would', async () => {
    placeHold('iauth_1', 2_000);
    harness.retrieved = authorization({
      status: 'reversed', approved: true, amount: 2_000, pending_request: null,
      request_history: [decided(true, 2_000), decided(true, 1_000, 'webhook_timeout')],
    });

    expect(await answer(deliver('issuing_authorization.request', increase()))).toBe(500);

    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it('Stripe approved it (timeout setting approve): the hold stays, because it will be captured', async () => {
    harness.retrieved = authorization({ status: 'pending', approved: true, amount: 2_000, pending_request: null, request_history: [decided(true, 2_000, 'webhook_timeout')] });

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('only THIS request\'s entry counts: a later declined increase does not release the purchase', async () => {
    // The same amount on purpose, so only the entry's position tells them apart.
    harness.retrieved = authorization({
      status: 'pending', approved: true, amount: 2_000, pending_request: null,
      request_history: [decided(true, 2_000), decided(false, 2_000)],
    });

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('an entry that does not match the amount this request asked for is not trusted', async () => {
    placeHold('iauth_1', 2_000);
    harness.retrieved = authorization({
      status: 'pending', approved: true, amount: 2_000, pending_request: null,
      request_history: [decided(true, 2_000), decided(false, 999)],
    });

    await answer(deliver('issuing_authorization.request', increase()));

    expect(liveHolds()).toEqual([['iauth_1', 2_000], ['iauth_1#request-1', 1_000]]);
  });

  it('a decline the card network overrode (network_fallback) keeps the hold', async () => {
    placeHold('iauth_1', 2_000);
    harness.retrieved = authorization({
      status: 'pending', approved: true, amount: 2_000, pending_request: null,
      request_history: [decided(true, 2_000), decided(false, 1_000, 'network_fallback')],
    });

    await answer(deliver('issuing_authorization.request', increase()));

    expect(liveHolds()).toEqual([['iauth_1', 2_000], ['iauth_1#request-1', 1_000]]);
  });

  it('Stripe has not decided yet: the hold stays', async () => {
    harness.retrieved = authorization();

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('Stripe cannot be asked: the hold stays, for the authorization\'s own events to settle', async () => {
    harness.retrieveError = new Error('connection reset');

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });
});

describe('our decline call fails', () => {
  it('no hold was placed, so nothing is released and Stripe is not asked', async () => {
    harness.declineError = new Error('This authorization is no longer pending.');
    placeHold('iauth_other', 4_500); // leaves $5, under the $20 asked

    expect(await answer(deliver('issuing_authorization.request', authorization()))).toBe(500);

    expect(harness.calls).toEqual(['decline iauth_1']);
    expect(liveHolds()).toEqual([['iauth_other', 4_500]]);
  });
});

describe('the money endpoint\'s subscription, as documented', () => {
  // Every event the route handles has to be subscribed at Stripe, or its
  // handler never runs. The operator's setup step left out
  // issuing_authorization.updated, which releases a reversed or expired hold.
  const route = readFileSync('app/api/webhooks/money/route.ts', 'utf8');
  const handled = [...(route.match(/const HANDLED_EVENT_TYPES = new Set<string>\(\[([\s\S]*?)\]\)/)?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
  const section = (file: string, start: string, end: RegExp) => {
    const text = readFileSync(file, 'utf8');
    const from = text.indexOf(start);
    expect(from, `${file} has the money endpoint's section`).toBeGreaterThan(-1);
    const rest = text.slice(from);
    const stop = rest.slice(1).search(end);
    return stop === -1 ? rest : rest.slice(0, stop + 1);
  };
  const mentioned = (text: string) => [...text.matchAll(/`((?:issuing_[a-z]+|account)\.[a-z_]+)`/g)].map((m) => m[1]);

  it('the route handles issuing_authorization.created', () => {
    expect(handled).toContain('issuing_authorization.created');
    expect(handled).toContain('issuing_authorization.updated');
  });

  it.each([
    ['docs/AGENT_HANDOFF.md', '`https://www.bubaly.com/api/webhooks/money` subscribed to', /\n> \d+\. /],
    ['docs/runbooks/LB-006-provider-callback-smoke.md', '## Stripe Issuing (wallet)', /\n## /],
  ])('%s subscribes exactly the events the route handles', (file, start, end) => {
    const listed = mentioned(section(file, start, end));
    expect([...new Set(listed)].sort()).toEqual([...handled].sort());
  });
});
