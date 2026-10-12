import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rewardReferral, type StripeCustomerCredits } from '@/lib/referrals/server';
import { rewardRecordFrom } from '@/lib/referrals/core';

// Actual reviewed application function + unchanged repository DB double.
// The only provider is this finite in-memory Stripe v1 idempotency recorder.
const REFERRER = '11111111-1111-4111-8111-111111111111';
const REFERRED = '22222222-2222-4222-8222-222222222222';
const REFERRAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_A = 'cus_synthetic_before_checkout';
const CUSTOMER_B = 'cus_synthetic_after_checkout';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
type Credit = { id: string; customer: string; amount: number; currency: string; metadata: Record<string, string> };
function fixture() {
  const db = createInMemorySupabase({ defaults: { referrals: { metadata: {}, rewarded_at: null }, billing_customers: { provider: 'stripe' } } });
  db.seed('referrals', [{ id: REFERRAL, code: 'SYNTHETIC-CODE', status: 'converted', converted_at: '2026-09-01T00:00:00Z', referrer_family_id: REFERRER, referred_family_id: REFERRED, referrer_reward_cents: 1000, referred_reward_cents: 0 }]);
  db.seed('billing_customers', [{ family_id: REFERRER, customer_ref: CUSTOMER_A }]);
  const credits: Credit[] = [];
  const calls: Record<string, unknown>[] = [];
  const keys = new Map<string, { fingerprint: string; id: string }>();
  const create = async (customer: string, params: { amount: number; currency: string; metadata?: Record<string, string> }, options?: { idempotencyKey?: string }) => {
    const fingerprint = JSON.stringify({ customer, params });
    const prior = options?.idempotencyKey ? keys.get(options.idempotencyKey) : undefined;
    calls.push({ operation: 'create', customer, reused: Boolean(prior) });
    if (prior && prior.fingerprint !== fingerprint) throw Object.assign(new Error('Synthetic Stripe v1: key reused with different customer/parameters'), { code: 'idempotency_key_in_use' });
    if (prior) return { id: prior.id };
    const row = { id: `cbtxn_synthetic_${credits.length + 1}`, customer, amount: params.amount, currency: params.currency, metadata: params.metadata ?? {} };
    credits.push(row);
    if (options?.idempotencyKey) keys.set(options.idempotencyKey, { id: row.id, fingerprint });
    return { id: row.id };
  };
  const stripe: StripeCustomerCredits = { customers: {
    retrieve: async id => ({ id, currency: 'usd' }),
    listBalanceTransactions: async id => ({ data: credits.filter(c => c.customer === id).map(c => ({ id: c.id, metadata: c.metadata })), has_more: false }),
    createBalanceTransaction: create,
  } };
  return { db, service: db as unknown as SupabaseClient<Database>, credits, calls, stripe, row: () => db.table('referrals')[0], setCustomer: (id: string) => { db.table('billing_customers')[0].customer_ref = id; }, expireKeys: () => { keys.clear(); } };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('independent referral retry ownership', () => {
  it('retains the first attempted customer through a concurrently converted worker so a later retry credits only once', async () => {
    const f = fixture();
    const aRetrieved = deferred(), releaseA = deferred(), bListed = deferred(), releaseB = deferred();
    const shared = f.stripe.customers;
    const a: StripeCustomerCredits = { customers: { ...shared,
      retrieve: async id => { aRetrieved.resolve(); await releaseA.promise; return shared.retrieve(id); },
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic response lost after creditA was created'); },
    } };
    const b: StripeCustomerCredits = { customers: { ...shared,
      listBalanceTransactions: async (...args) => { const snapshot = await shared.listBalanceTransactions(...args); bListed.resolve(); await releaseB.promise; return snapshot; },
    } };
    const first = rewardReferral(f.service, REFERRAL, { stripe: a });
    await aRetrieved.promise;
    f.setCustomer(CUSTOMER_B);
    const overlapping = rewardReferral(f.service, REFERRAL, { stripe: b });
    await bListed.promise;
    releaseA.resolve();
    expect(await first).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(f.credits).toHaveLength(1);
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);
    releaseB.resolve();
    expect(await overlapping).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(f.row().status).toBe('converted');
    const pointerAfterRace = rewardRecordFrom(f.row().metadata).referrer_customer;
    f.expireKeys(); // Separate subsequent renewal, not a24-hour-held call.
    const late = await rewardReferral(f.service, REFERRAL, { stripe: f.stripe });
    console.log('INDEPENDENT_REFERRAL_RACE', JSON.stringify({ pointerAfterRace, late, credits: f.credits, row: f.row(), calls: f.calls }));
    expect(late).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits, 'one referral side must not credit both the old and current customer').toHaveLength(1);
  });

  it('serial customer replacement after a lost response keeps the original credit and does not create another', async () => {
    const f = fixture();
    const loseAnswer: StripeCustomerCredits = { customers: { ...f.stripe.customers, createBalanceTransaction: async (...args) => { await f.stripe.customers.createBalanceTransaction(...args); throw new Error('Synthetic lost response'); } } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe: loseAnswer })).toMatchObject({ outcome: 'credit_failed' });
    f.setCustomer(CUSTOMER_B);
    f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);
    expect(f.credits[0].customer).toBe(CUSTOMER_A);
  });

  it('a same-customer stale lookup uses the existing identical idempotent result', async () => {
    const f = fixture();
    const aRetrieved = deferred(), releaseA = deferred(), bListed = deferred(), releaseB = deferred();
    const shared = f.stripe.customers;
    const a: StripeCustomerCredits = { customers: { ...shared,
      retrieve: async id => { aRetrieved.resolve(); await releaseA.promise; return shared.retrieve(id); },
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic lost response'); },
    } };
    const b: StripeCustomerCredits = { customers: { ...shared,
      listBalanceTransactions: async (...args) => { const snapshot = await shared.listBalanceTransactions(...args); bListed.resolve(); await releaseB.promise; return snapshot; },
    } };
    const first = rewardReferral(f.service, REFERRAL, { stripe: a });
    await aRetrieved.promise;
    const overlapping = rewardReferral(f.service, REFERRAL, { stripe: b });
    await bListed.promise;
    releaseA.resolve();
    expect(await first).toMatchObject({ outcome: 'credit_failed' });
    releaseB.resolve();
    expect(await overlapping).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);
  });

  it('the finite provider refuses a different-customer key reuse until expiry, then treats it as a new request', async () => {
    const f = fixture();
    const params = { amount: -1000, currency: 'usd', metadata: { referral_id: REFERRAL, side: 'referrer' } };
    const opts = { idempotencyKey: 'synthetic-key-not-a-real-provider-request' };
    await f.stripe.customers.createBalanceTransaction(CUSTOMER_A, params, opts);
    await expect(f.stripe.customers.createBalanceTransaction(CUSTOMER_B, params, opts)).rejects.toThrow('different customer/parameters');
    expect(f.credits).toHaveLength(1);
    f.expireKeys();
    await f.stripe.customers.createBalanceTransaction(CUSTOMER_B, params, opts);
    expect(f.credits).toHaveLength(2);
  });
});

describe('durable attempt ownership across newly started and stale workers', () => {
  it('a worker started after the first customer is saved cannot replace that unresolved customer', async () => {
    const f = fixture();
    const createReached = deferred(), releaseCreate = deferred();
    const shared = f.stripe.customers;
    const a: StripeCustomerCredits = { customers: { ...shared,
      createBalanceTransaction: async (...args) => { createReached.resolve(); await releaseCreate.promise; return shared.createBalanceTransaction(...args); },
    } };
    const first = rewardReferral(f.service, REFERRAL, { stripe: a });
    await createReached.promise;
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);
    f.setCustomer(CUSTOMER_B);
    const newWorker = await rewardReferral(f.service, REFERRAL, { stripe: f.stripe });
    releaseCreate.resolve();
    const firstOutcome = await first;
    console.log('OWNED_REFERRAL_REVIEW', JSON.stringify({ case: 'post-claim-worker', newWorker, firstOutcome, credits: f.credits, row: f.row() }));
    expect(f.credits).toHaveLength(1);
    expect(f.credits[0].customer, 'an unresolved attempt remains on its original customer').toBe(CUSTOMER_A);
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);
    expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe(f.credits[0].id);
  });

  it('the same ownership rule covers the referred side after the zero referrer side settles', async () => {
    const f = fixture();
    f.row().referrer_reward_cents = 0;
    f.row().referred_reward_cents = 1000;
    f.db.replace('billing_customers', [{ family_id: REFERRED, customer_ref: CUSTOMER_A }]);
    const reached = deferred(), release = deferred();
    const shared = f.stripe.customers;
    const first = rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { reached.resolve(); await release.promise; return shared.createBalanceTransaction(...args); },
    } } });
    await reached.promise;
    expect(rewardRecordFrom(f.row().metadata).referred_customer).toBe(CUSTOMER_A);
    f.setCustomer(CUSTOMER_B);
    await rewardReferral(f.service, REFERRAL, { stripe: f.stripe });
    release.resolve();
    await first;
    expect(f.credits).toHaveLength(1);
    expect(f.credits[0].customer).toBe(CUSTOMER_A);
    expect(rewardRecordFrom(f.row().metadata)).toMatchObject({ referrer_skipped: 'zero_amount', referred_txn: f.credits[0].id, referred_customer: CUSTOMER_A });
  });

  it('a stale worker cannot replace newly saved unrelated metadata before submitting a credit', async () => {
    const f = fixture();
    const reached = deferred(), release = deferred();
    const shared = f.stripe.customers;
    const running = rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      retrieve: async id => { reached.resolve(); await release.promise; return shared.retrieve(id); },
    } } });
    await reached.promise;
    f.row().metadata = { email_sent_at: ['2026-10-11T00:00:00Z'], unrelated: { keep: 'synthetic' } };
    release.resolve();
    const outcome = await running;
    expect(outcome).toMatchObject({ outcome: 'credit_failed' });
    expect(f.credits).toHaveLength(0);
    expect(f.row().metadata).toEqual({ email_sent_at: ['2026-10-11T00:00:00Z'], unrelated: { keep: 'synthetic' } });
  });

  it('an unresolved owned customer becoming unavailable holds the reward instead of replacing its unknown credit', async () => {
    const f = fixture();
    const shared = f.stripe.customers;
    await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic response lost'); },
    } } });
    expect(f.credits).toHaveLength(1);
    f.setCustomer(CUSTOMER_B);
    f.expireKeys();
    const unavailable: StripeCustomerCredits = { customers: { ...shared,
      retrieve: async id => id === CUSTOMER_A ? { id, deleted: true } : shared.retrieve(id),
      listBalanceTransactions: async (...args) => { if (args[0] === CUSTOMER_A) throw Object.assign(new Error('Synthetic missing owned customer'), { code: 'resource_missing' }); return shared.listBalanceTransactions(...args); },
    } };
    const retry = await rewardReferral(f.service, REFERRAL, { stripe: unavailable });
    expect(['missing_customer', 'credit_failed']).toContain(retry.outcome);
    expect(f.row().status).toBe('converted');
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);
    expect(f.credits).toHaveLength(1);
  });

  it('an existing owned credit is recovered when the current billing reference temporarily disappears', async () => {
    const f = fixture();
    const shared = f.stripe.customers;
    await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic response lost'); },
    } } });
    f.db.replace('billing_customers', []);
    f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);
    expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe(f.credits[0].id);
  });

  it('an empty stale history holds a saved attempt without resubmitting changed parameters', async () => {
    const f = fixture();
    const shared = f.stripe.customers;
    await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic response lost'); },
    } } });
    f.row().referrer_reward_cents = 2000;
    const stale: StripeCustomerCredits = { customers: { ...shared,
      retrieve: async id => ({ id, currency: 'eur' }),
      listBalanceTransactions: async () => ({ data: [], has_more: false }),
    } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe: stale })).toMatchObject({ outcome: 'credit_failed', error: expect.stringContaining('manual reconciliation') });
    expect(f.calls.filter(call => call.operation === 'create')).toHaveLength(1);
    expect(f.row().status).toBe('converted');
    expect(f.credits).toHaveLength(1);
    expect(f.credits[0]).toMatchObject({ amount: -1000, currency: 'usd' });
  });

  it('malformed durable attempt metadata refuses before any provider operation', async () => {
    const f = fixture();
    f.row().metadata = { reward_attempts: { referrer: { customer: CUSTOMER_A, params: { amount: -1000 }, idempotencyKey: 'wrong-synthetic-key' } } };
    let providerOperations = 0;
    const shared = f.stripe.customers;
    const stripe: StripeCustomerCredits = { customers: {
      retrieve: async (...args) => { providerOperations++; return shared.retrieve(...args); },
      listBalanceTransactions: async (...args) => { providerOperations++; return shared.listBalanceTransactions(...args); },
      createBalanceTransaction: async (...args) => { providerOperations++; return shared.createBalanceTransaction(...args); },
    } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe })).toMatchObject({ outcome: 'credit_failed' });
    expect(providerOperations).toBe(0);
    expect(f.credits).toHaveLength(0);
  });

  it('a null original metadata document can acquire an owned attempt and settle both sides safely', async () => {
    const f = fixture();
    f.row().metadata = null;
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);
    expect(rewardRecordFrom(f.row().metadata)).toMatchObject({ referrer_txn: f.credits[0].id, referred_skipped: 'zero_amount' });
  });
});

describe('attempt reconciliation and whole metadata completion controls', () => {
  it('changing a reward to zero does not discard an already created unresolved credit', async () => {
    const f = fixture();
    const shared = f.stripe.customers;
    await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic response lost'); },
    } } });
    f.row().referrer_reward_cents = 0;
    f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);
    expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe(f.credits[0].id);
    expect(rewardRecordFrom(f.row().metadata).referrer_skipped ?? null).toBeNull();
  });

  it('the final rewarded flip preserves a simultaneous unrelated metadata write and can be retried', async () => {
    const f = fixture();
    let changed = false;
    const service = new Proxy(f.service, {
      get(target, key, receiver) {
        if (key !== 'from') return Reflect.get(target, key, receiver);
        return (table: string) => {
          const query = target.from(table as never);
          if (table !== 'referrals') return query;
          return new Proxy(query, {
            get(builder, method, context) {
              if (method !== 'update') return Reflect.get(builder, method, context);
              return (values: Record<string, unknown>) => {
                if (!changed && values.status === 'rewarded') {
                  changed = true;
                  f.row().metadata = { ...(f.row().metadata as Record<string, unknown>), later_email: ['synthetic-current-message'] };
                }
                return (builder as unknown as { update: (value: unknown) => unknown }).update(values);
              };
            },
          });
        };
      },
    });
    expect(await rewardReferral(service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'persist_failed' });
    expect(f.row().metadata).toHaveProperty('later_email', ['synthetic-current-message']);
    expect(f.credits).toHaveLength(1);
    f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.row().metadata).toHaveProperty('later_email', ['synthetic-current-message']);
    expect(f.credits).toHaveLength(1);
  });

  it('a stale initial snapshot cannot erase another side’s successful transaction record', async () => {
    const f = fixture();
    const reached = deferred(), release = deferred();
    const shared = f.stripe.customers;
    const running = rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      retrieve: async id => { reached.resolve(); await release.promise; return shared.retrieve(id); },
    } } });
    await reached.promise;
    f.row().metadata = { reward: { referred_txn: 'cbtxn_synthetic_other_side_already_confirmed' } };
    release.resolve();
    expect(await running).toMatchObject({ outcome: 'credit_failed' });
    expect(rewardRecordFrom(f.row().metadata).referred_txn).toBe('cbtxn_synthetic_other_side_already_confirmed');
    expect(f.credits).toHaveLength(0);
  });
});

import { recordReferralEmailInvite, rollbackReferralEmailInvite } from '@/lib/referrals/server';
import { DEFAULT_REFERRAL_CONFIG, referralEmailSendTimes } from '@/lib/referrals/core';

// Delay the actual DB execution after the application has constructed its
// whole-document update from a captured row. Reads and DB equality are the
// repository helper's unchanged behavior; no application source is overlaid.
function heldUpdate(service: SupabaseClient<Database>, predicate: (values: Record<string, unknown>) => boolean, reached: ReturnType<typeof deferred<void>>, release: ReturnType<typeof deferred<void>>) {
  return new Proxy(service, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => {
        const raw = target.from(table as never);
        const wrap = (builder: unknown, held = false): unknown => new Proxy(builder as object, {
          get(object, method) {
            const value = Reflect.get(object, method, object);
            if (typeof value !== 'function') return value;
            if (method === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
              if (!held) return Reflect.apply(value, object, [resolve, reject]);
              reached.resolve();
              return release.promise.then(() => Reflect.apply(value, object, [resolve, reject]));
            };
            if (method === 'maybeSingle') return async (...args: unknown[]) => {
              if (held) { reached.resolve(); await release.promise; }
              return Reflect.apply(value, object, args);
            };
            return (...args: unknown[]) => {
              const nextHeld = held || (method === 'update' && table === 'referrals' && predicate(args[0] as Record<string, unknown>));
              const result = Reflect.apply(value, object, args);
              return result && typeof result === 'object' ? wrap(result, nextHeld) : result;
            };
          },
        });
        return wrap(raw);
      };
    },
  });
}

describe('every referral metadata writer preserves newer attempt and completion records', () => {
  const stamp = new Date('2026-10-11T00:00:00Z');
  for (const writer of ['invite', 'rollback'] as const) {
    it.each(['claim', 'transaction', 'rewarded'] as const)(`${writer} captured before a reward cannot overwrite its newer %s`, async phase => {
      const f = fixture();
      f.row().referred_email = 'synthetic@example.invalid';
      f.row().metadata = { email_sent_at: [stamp.toISOString()], unrelated: 'keep-synthetic' };
      const externalReached = deferred(), releaseExternal = deferred();
      const externalService = heldUpdate(f.service, values => Boolean(values.metadata), externalReached, releaseExternal);
      const external = writer === 'invite'
        ? recordReferralEmailInvite(externalService, { referrerFamilyId: REFERRER, code: 'SYNTHETIC-CODE', email: 'synthetic@example.invalid', config: DEFAULT_REFERRAL_CONFIG, now: new Date(stamp.getTime() + 60_000) })
        : rollbackReferralEmailInvite(externalService, { rowId: REFERRAL, created: false, sentAt: stamp });
      await externalReached.promise;
      const rewardReached = deferred(), releaseReward = deferred();
      const shared = f.stripe.customers;
      const rewardService = phase === 'transaction' ? heldUpdate(f.service, values => values.status === 'rewarded', rewardReached, releaseReward) : f.service;
      const stripe: StripeCustomerCredits = phase === 'claim' ? { customers: { ...shared,
        createBalanceTransaction: async (...args) => { rewardReached.resolve(); await releaseReward.promise; await shared.createBalanceTransaction(...args); throw new Error('Synthetic lost reply'); },
      } } : f.stripe;
      const reward = rewardReferral(rewardService, REFERRAL, { stripe });
      if (phase === 'rewarded') await reward; else await rewardReached.promise;
      const newer = structuredClone(f.row().metadata);
      const newerStatus = f.row().status;
      releaseExternal.resolve();
      const externalOutcome = await external;
      const afterExternal = structuredClone(f.row().metadata);
      const afterExternalStatus = f.row().status;
      releaseReward.resolve();
      await reward;
      f.setCustomer(CUSTOMER_B); f.expireKeys();
      const retry = await rewardReferral(f.service, REFERRAL, { stripe: f.stripe });
      expect(afterExternal, 'the older external document must not replace any current reward fields').toEqual(newer);
      expect(afterExternalStatus).toBe(newerStatus);
      if (writer === 'invite') expect(externalOutcome).toEqual({ ok: false, reason: 'write_failed' });
      else expect(console.error).toHaveBeenCalledWith('[referrals/email] invite rollback update failed', expect.any(Object));
      expect(['rewarded', 'already_rewarded']).toContain(retry.outcome);
      expect(f.credits).toHaveLength(1);
      expect(f.credits[0].customer).toBe(CUSTOMER_A);
      expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe(f.credits[0].id);
    });
  }

  it('a current invitation send and rollback retain the settled attempt and transaction', async () => {
    const f = fixture();f.row().referred_email = 'synthetic@example.invalid';
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    const settled = structuredClone(f.row().metadata) as Record<string, unknown>;
    expect(await recordReferralEmailInvite(f.service, { referrerFamilyId: REFERRER, code: 'SYNTHETIC-CODE', email: 'synthetic@example.invalid', config: DEFAULT_REFERRAL_CONFIG, now: stamp })).toMatchObject({ ok: true, created: false });
    expect(f.row().metadata).toMatchObject(settled);
    expect(referralEmailSendTimes(f.row().metadata)).toEqual([stamp.toISOString()]);
    await rollbackReferralEmailInvite(f.service, { rowId: REFERRAL, created: false, sentAt: stamp });
    expect(f.row().metadata).toMatchObject(settled);
    expect(referralEmailSendTimes(f.row().metadata)).toEqual([]);
    expect(f.row().status).toBe('rewarded');expect(f.credits).toHaveLength(1);
  });

  it('a current null metadata invitation snapshot is accepted without blind writes', async () => {
    const f = fixture();f.row().referred_email = 'synthetic@example.invalid';f.row().metadata = null;
    expect(await recordReferralEmailInvite(f.service, { referrerFamilyId: REFERRER, code: 'SYNTHETIC-CODE', email: 'synthetic@example.invalid', config: DEFAULT_REFERRAL_CONFIG, now: stamp })).toMatchObject({ ok: true, created: false });
    expect(referralEmailSendTimes(f.row().metadata)).toEqual([stamp.toISOString()]);
    await rollbackReferralEmailInvite(f.service, { rowId: REFERRAL, created: false, sentAt: stamp });
    expect(referralEmailSendTimes(f.row().metadata)).toEqual([]);
  });
});

describe('safe legacy reconciliation requires a known accessible outcome', () => {
  it('recovers a matching credit on the available old customer without crediting its replacement', async () => {
    const f = fixture();
    const txn = await f.stripe.customers.createBalanceTransaction(CUSTOMER_A, { amount: -1000, currency: 'usd', metadata: { referral_id: REFERRAL, family_id: REFERRER, side: 'referrer' } });
    f.row().metadata = { reward: { referrer_customer: CUSTOMER_A } };f.setCustomer(CUSTOMER_B);f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe(txn.id);expect(f.credits).toHaveLength(1);
  });

  it('a stored confirmed transaction skips unavailable legacy history and settles the remaining side', async () => {
    const f = fixture();f.row().metadata = { reward: { referrer_customer: CUSTOMER_A, referrer_txn: 'cbtxn_synthetic_confirmed' } };f.setCustomer(CUSTOMER_B);
    let providerOperations = 0;
    const stripe: StripeCustomerCredits = { customers: {
      retrieve: async () => { providerOperations++; throw new Error('Unavailable synthetic history'); },
      listBalanceTransactions: async () => { providerOperations++; throw new Error('Unavailable synthetic history'); },
      createBalanceTransaction: async () => { providerOperations++; throw new Error('Must not create'); },
    } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(providerOperations).toBe(0);expect(rewardRecordFrom(f.row().metadata).referrer_txn).toBe('cbtxn_synthetic_confirmed');
  });

  it('a failed preflight with no saved or submitted attempt allows the later first customer credit', async () => {
    const f = fixture();const shared = f.stripe.customers;
    expect(await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared, listBalanceTransactions: async () => { throw new Error('Synthetic preflight outage'); } } } })).toMatchObject({ outcome: 'credit_failed' });
    expect(f.row().metadata).toEqual({});expect(f.credits).toHaveLength(0);
    f.setCustomer(CUSTOMER_B);f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);expect(f.credits[0].customer).toBe(CUSTOMER_B);
  });
});

describe('saved unknown outcomes are reconciliation only, without a second provider submission', () => {
  it('after key expiry, empty history cannot resubmit a credit whose first answer was lost', async () => {
    const f = fixture();const shared = f.stripe.customers;
    await rewardReferral(f.service, REFERRAL, { stripe: { customers: { ...shared,
      createBalanceTransaction: async (...args) => { await shared.createBalanceTransaction(...args); throw new Error('Synthetic lost reply'); },
    } } });
    expect(f.credits).toHaveLength(1);f.expireKeys();
    const stale: StripeCustomerCredits = { customers: { ...shared, listBalanceTransactions: async () => ({ data: [], has_more: false }) } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe: stale })).toMatchObject({ outcome: 'credit_failed', error: expect.stringContaining('manual reconciliation') });
    expect(f.credits).toHaveLength(1);expect(f.calls.filter(call => call.operation === 'create')).toHaveLength(1);
    expect(f.row().status).toBe('converted');
    // Once the actual old credit is observable, a retry only records its id.
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'rewarded' });
    expect(f.credits).toHaveLength(1);expect(f.calls.filter(call => call.operation === 'create')).toHaveLength(1);
  });

  it('an available but empty prior legacy history is held rather than treated as permission to submit again', async () => {
    const f = fixture();f.row().metadata = { reward: { referrer_customer: CUSTOMER_A } };f.setCustomer(CUSTOMER_B);
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'credit_failed', error: expect.stringContaining('manual reconciliation') });
    expect(f.credits).toHaveLength(0);expect(f.calls.filter(call => call.operation === 'create')).toHaveLength(0);
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);expect(f.row().status).toBe('converted');
  });

  it('a claimed request with no provider response and no observable credit remains held without an automatic second submission', async () => {
    const f = fixture();const shared = f.stripe.customers;let submissions = 0;
    const failed: StripeCustomerCredits = { customers: { ...shared, createBalanceTransaction: async () => { submissions++;throw new Error('Synthetic network outcome cannot be classified'); } } };
    expect(await rewardReferral(f.service, REFERRAL, { stripe: failed })).toMatchObject({ outcome: 'credit_failed' });
    expect(submissions).toBe(1);expect(f.credits).toHaveLength(0);f.expireKeys();
    expect(await rewardReferral(f.service, REFERRAL, { stripe: f.stripe })).toMatchObject({ outcome: 'credit_failed', error: expect.stringContaining('manual reconciliation') });
    expect(f.credits).toHaveLength(0);expect(f.calls.filter(call => call.operation === 'create')).toHaveLength(0);
    expect(rewardRecordFrom(f.row().metadata).referrer_customer).toBe(CUSTOMER_A);expect(f.row().status).toBe('converted');
  });
});
