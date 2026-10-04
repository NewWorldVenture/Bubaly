import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A card hold nothing released is reconciled against Stripe once a day.
 *
 * A `processing` card hold is released when an event reaches the money
 * webhook. Some never do, and the child's money stays held:
 *   - our approve call failed and Stripe could not be asked what it decided
 *     (a-hold-stripe-declined-for-us-is-released.test.ts keeps that hold);
 *   - the function died between reserving the hold and the approve call;
 *   - a replayed request re-held an authorization that had already closed;
 *   - the endpoint was never subscribed to `.updated`/`.created`, which the
 *     operator setup step omitted until #962.
 * The cron asks Stripe for each such authorization and runs it through the
 * webhook's own handler, which is idempotent: a live authorization changes
 * nothing, one that is over is settled and closed, a declined request is
 * released.
 */

const FAMILY = 'family-1';
const WALLET = 'wallet-a';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  authorizations: new Map<string, unknown>(),
  retrieved: [] as { id: string; stripeAccount?: string }[],
  fail: new Map<string, Error>(),
  configured: true,
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getStripe: () => {
    if (!harness.configured) throw new Error('STRIPE_SECRET_KEY is not set');
    return {
      issuing: {
        authorizations: {
          retrieve: async (id: string, _params: unknown, opts?: { stripeAccount?: string }) => {
            harness.retrieved.push({ id, stripeAccount: opts?.stripeAccount });
            const failure = harness.fail.get(id);
            if (failure) throw failure;
            const auth = harness.authorizations.get(id);
            if (!auth) throw Object.assign(new Error(`No such issuing_authorization: '${id}'`), { code: 'resource_missing' });
            return auth;
          },
        },
      },
    };
  },
}));

const { GET } = await import('@/app/api/cron/card-holds/route');

let db: InMemorySupabase;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function store(rpc: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  db = createInMemorySupabase({ rpc });
  harness.db = db;
  db.seed('stripe_issuing_cards', [
    { id: 'card-row-1', family_id: FAMILY, child_wallet_id: WALLET, stripe_card_id: 'ic_child', is_frozen: false, blocked_categories: [], status: 'active' },
  ]);
  db.seed('stripe_connected_accounts', [{ id: 'acct-row-1', family_id: FAMILY, stripe_account_id: 'acct_family' }]);
  db.seed('wallet_buckets', [{ id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' }]);
  db.seed('wallet_transactions', [
    { id: 'txn-topup', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5_000, stripe_ref: null, created_at: ago(48 * HOUR) },
  ]);
  db.seed('wallet_audit_logs', []);
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.authorizations = new Map();
  harness.retrieved = [];
  harness.fail = new Map();
  harness.configured = true;
  store();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const ledger = () => db.table('wallet_transactions') as Row[];
const liveHolds = () => ledger().filter((r) => r.type === 'card_spend' && r.status === 'processing').map((r) => [r.stripe_ref, r.amount_cents]);
const spendableCents = () => ledger()
  .filter((r) => r.bucket_id === 'bucket-spend' && (r.status === 'completed' || r.status === 'processing'))
  .reduce((sum, r) => sum + (r.direction === 'credit' ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
function hold(ref: string, cents: number, age = 3 * HOUR) {
  ledger().push({
    id: `hold-${ref}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend',
    status: 'processing', direction: 'debit', amount_cents: cents, stripe_ref: ref, metadata: { source: 'issuing', kind: 'hold' }, created_at: ago(age),
  });
}
const decided = (approved: boolean, amount: number, reason = approved ? 'webhook_approved' : 'webhook_timeout') => ({ approved, amount, reason });
function stripeHas(id: string, over: Record<string, unknown>) {
  harness.authorizations.set(id, {
    id, object: 'issuing.authorization', status: 'pending', approved: true, amount: 2_000, currency: 'usd',
    card: 'ic_child', merchant_data: { name: 'Corner Books' }, pending_request: null,
    request_history: [decided(true, 2_000)], transactions: [], ...over,
  } as unknown as Stripe.Issuing.Authorization);
}
async function run(secret = 'cron-secret') {
  const res = await GET(new Request('https://bubaly.test/api/cron/card-holds', { headers: { authorization: `Bearer ${secret}` } }) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The store, except that one table answers every query with `error`. */
function failing(table: string, error: { code?: string; message: string }) {
  const answer = { data: null, error, count: null };
  const builder: unknown = new Proxy({}, {
    get: (_target, prop) => (prop === 'then' ? (resolve: (v: unknown) => unknown) => resolve(answer) : () => builder),
  });
  harness.db = new Proxy(db, {
    get: (target, prop, receiver) => (prop === 'from'
      ? (name: string) => (name === table ? builder : target.from(name))
      : Reflect.get(target, prop, receiver)),
  });
}
const capture = (id: string, cents: number) => ({ id, object: 'issuing.transaction', type: 'capture', amount: -cents, card: 'ic_child', authorization: 'iauth_1', merchant_data: { name: 'Corner Books' } });
const posted = (id: string, cents: number) => ledger().push({
  id: `txn-${id}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'completed',
  direction: 'debit', amount_cents: cents, stripe_ref: id, created_at: ago(2 * HOUR),
});

describe('the card-hold reconcile cron', () => {
  it('refuses a caller without the cron secret', async () => {
    hold('iauth_1', 2_000);
    stripeHas('iauth_1', { status: 'closed', approved: false, request_history: [decided(false, 2_000)] });

    expect((await run('wrong')).status).toBe(401);
    expect(harness.retrieved).toEqual([]);
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('releases a hold whose purchase Stripe declined on timeout (the .created never handled)', async () => {
    hold('iauth_1', 2_000);
    stripeHas('iauth_1', { status: 'closed', approved: false, amount: 0, request_history: [decided(false, 2_000)] });

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ ok: true, authorizations: 1, reconciled: 1, failed: 0, unserved: 0 }));
    expect(liveHolds()).toEqual([]);
    expect(spendableCents()).toBe(5_000);
  });

  it.each(['reversed', 'expired'])('releases every hold of a %s authorization, its increase and remainder included', async (statusName) => {
    hold('iauth_1#remainder', 600);
    hold('iauth_1#request-1', 1_000);
    stripeHas('iauth_1', { status: statusName, request_history: [decided(true, 2_000), decided(true, 1_000)] });

    await run();

    expect(liveHolds()).toEqual([]);
    expect(harness.retrieved).toEqual([{ id: 'iauth_1', stripeAccount: 'acct_family' }]);
  });

  describe('captures: the cron never posts one', () => {
    beforeEach(() => {
      hold('iauth_1', 2_000);
      stripeHas('iauth_1', { status: 'closed', request_history: [decided(true, 2_000)], transactions: [capture('ipi_1', 1_500)] });
    });

    it('a closed authorization whose capture is not in the ledger yet keeps its hold for that capture\'s own event', async () => {
      const { status, body } = await run();

      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ awaitingCapture: 1, reconciled: 0 }));
      expect(ledger().filter((r) => r.stripe_ref === 'ipi_1')).toEqual([]);
      expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
    });

    it('once its capture is posted, the rest of the hold is released', async () => {
      posted('ipi_1', 1_500);

      await run();

      expect(ledger().filter((r) => r.stripe_ref === 'ipi_1')).toHaveLength(1);
      expect(liveHolds()).toEqual([]);
      expect(spendableCents()).toBe(3_500);
    });

    it('two runs at the same minute (vercel.json and the dispatcher) debit nothing twice', async () => {
      posted('ipi_1', 1_500);

      const both = await Promise.all([run(), run()]);

      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect(ledger().filter((r) => r.stripe_ref === 'ipi_1')).toHaveLength(1);
      expect(liveHolds()).toEqual([]);
      expect(spendableCents()).toBe(3_500);
    });
  });

  it('leaves a live authorization alone, and releases only an increase Stripe declined on it', async () => {
    hold('iauth_1', 2_000);
    hold('iauth_1#request-1', 1_000);
    stripeHas('iauth_1', { status: 'pending', request_history: [decided(true, 2_000), decided(false, 1_000)] });

    const { status } = await run();

    expect(status).toBe(200);
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('asks only about holds more than an hour old: younger ones still have their own events coming', async () => {
    hold('iauth_new', 2_000, 59 * 60 * 1000);
    hold('iauth_old', 500, 61 * 60 * 1000);
    stripeHas('iauth_new', { status: 'closed', approved: false, request_history: [decided(false, 2_000)] });
    stripeHas('iauth_old', { status: 'closed', approved: false, amount: 0, request_history: [decided(false, 500)] });

    await run();

    expect(harness.retrieved.map((r) => r.id)).toEqual(['iauth_old']);
    expect(liveHolds()).toEqual([['iauth_new', 2_000]]);
  });

  it('asks Stripe once per authorization, and ignores what is not a live card hold', async () => {
    hold('iauth_1', 2_000);
    hold('iauth_1#request-1', 1_000);
    hold('iauth_2', 500);
    hold('not_an_authorization', 300);
    ledger().push({ id: 'hold-gone', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-spend', type: 'card_spend', status: 'cancelled', direction: 'debit', amount_cents: 900, stripe_ref: 'iauth_gone', created_at: ago(5 * HOUR) });
    stripeHas('iauth_1', { status: 'pending', request_history: [decided(true, 2_000), decided(true, 1_000)] });
    stripeHas('iauth_2', { status: 'pending', amount: 500, request_history: [decided(true, 500)] });

    const { body } = await run();

    expect(harness.retrieved.map((r) => r.id).sort()).toEqual(['iauth_1', 'iauth_2']);
    expect(body).toEqual(expect.objectContaining({ holds: 4, authorizations: 2 }));
  });

  it('asks oldest first, at most five at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      hold(`iauth_q${i}`, 10, (20 - i) * HOUR);
      stripeHas(`iauth_q${i}`, { status: 'pending', amount: 10, request_history: [decided(true, 10)] });
    }
    const realGet = harness.authorizations.get.bind(harness.authorizations);
    // Each answer takes a few milliseconds, so the workers overlap.
    harness.authorizations.get = (id: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      return new Promise((resolve) => setTimeout(() => { inFlight--; resolve(realGet(id)); }, 5)) as never;
    };

    await run();

    expect(harness.retrieved.slice(0, 5).map((r) => r.id)).toEqual(['iauth_q0', 'iauth_q1', 'iauth_q2', 'iauth_q3', 'iauth_q4']);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('stops starting new questions when its budget is spent, and says what it did not reach', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 8; i++) {
        hold(`iauth_b${i}`, 10, (20 - i) * HOUR);
        stripeHas(`iauth_b${i}`, { status: 'pending', amount: 10, request_history: [decided(true, 10)] });
      }
      const realGet = harness.authorizations.get.bind(harness.authorizations);
      // Each answer takes 20 seconds of the run's clock.
      harness.authorizations.get = (id: string) => { vi.setSystemTime(Date.now() + 20_000); return realGet(id); };

      const { status, body } = await run();

      expect(status).toBe(502);
      expect(body).toEqual(expect.objectContaining({ ok: false, failed: 0 }));
      expect(Number(body.unserved)).toBeGreaterThan(0);
      expect(harness.retrieved.length + Number(body.unserved)).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Stripe failure on one authorization is a 502, and the others are still reconciled', async () => {
    hold('iauth_1', 2_000);
    hold('iauth_2', 500);
    harness.fail.set('iauth_1', new Error('Stripe is having a moment'));
    stripeHas('iauth_2', { status: 'closed', approved: false, amount: 0, request_history: [decided(false, 500)] });

    const { status, body } = await run();

    expect(status).toBe(502);
    expect(body).toEqual(expect.objectContaining({ ok: false, failed: 1, reconciled: 1 }));
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('a settle that throws is a failure, not a 200', async () => {
    store({ wallet_close_card_auth: () => { throw new Error('the close failed'); } });
    hold('iauth_1', 2_000);
    stripeHas('iauth_1', { status: 'expired' });

    const { status, body } = await run();

    expect(status).toBe(502);
    expect(body).toEqual(expect.objectContaining({ failed: 1 }));
  });

  it('an authorization Stripe does not know keeps its hold and is surfaced, not counted as a clean run', async () => {
    hold('iauth_ghost', 700);

    const { status, body } = await run();

    expect(status).toBe(502);
    expect(body).toEqual(expect.objectContaining({ ok: false, unknown: 1, failed: 0 }));
    expect(liveHolds()).toEqual([['iauth_ghost', 700]]);
  });

  it('a family with no connected account is surfaced, and Stripe is not asked on the platform', async () => {
    db.table('stripe_connected_accounts').length = 0;
    hold('iauth_1', 2_000);
    stripeHas('iauth_1', { status: 'closed', approved: false, request_history: [decided(false, 2_000)] });

    const { status, body } = await run();

    expect(status).toBe(502);
    expect(body).toEqual(expect.objectContaining({ noAccount: 1 }));
    expect(harness.retrieved).toEqual([]);
    expect(liveHolds()).toEqual([['iauth_1', 2_000]]);
  });

  it('with the 0487 functions, an authorization that is over goes through wallet_close_card_auth', async () => {
    const closes: unknown[] = [];
    store({ wallet_close_card_auth: (args) => { closes.push(args); return { ok: true, released_cents: 0 }; } });
    hold('iauth_1', 2_000);
    stripeHas('iauth_1', { status: 'expired' });

    await run();

    expect(closes).toEqual([{ p_family: FAMILY, p_child_wallet: WALLET, p_auth_id: 'iauth_1' }]);
  });

  it('a wallet not deployed yet is a clean no-op; any other read failure is a 500', async () => {
    failing('wallet_transactions', { code: '42P01', message: 'relation "public.wallet_transactions" does not exist' });
    expect(await run()).toEqual({ status: 200, body: { ok: true, skipped: 'wallet_not_deployed' } });

    store();
    hold('iauth_1', 2_000);
    failing('stripe_connected_accounts', { code: '57014', message: 'canceling statement due to statement timeout' });
    expect((await run()).status).toBe(500);
    expect(harness.retrieved).toEqual([]);
  });

  it('without Stripe configured, it is a clean no-op', async () => {
    harness.configured = false;
    hold('iauth_1', 2_000);

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, skipped: 'stripe_not_configured' });
  });

  it('is scheduled by both schedulers, at the same daily minute', async () => {
    const { readFileSync } = await import('node:fs');
    const { SCHEDULES } = await import('../scripts/cron-dispatch.mjs');
    const crons = (JSON.parse(readFileSync('vercel.json', 'utf8')).crons ?? []) as { path: string; schedule: string }[];
    const vercel = crons.find((c) => c.path === '/api/cron/card-holds');
    expect(vercel?.schedule).toBe((SCHEDULES as Record<string, string>)['/api/cron/card-holds']);
  });
});
