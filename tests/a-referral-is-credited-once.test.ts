// A referral is credited once, however late its retry comes.
//
// `rewardReferral` credits each family's Stripe customer balance, real money
// off their next invoices, and records the credit's id on the referral row.
// When either half fails (Stripe made the credit but the answer was lost, or
// the row could not be written), the side stays "owed" and the next call tries
// again. Its only guard against crediting twice was the Stripe idempotency key,
// and Stripe keeps those for about 24 hours. The next call comes from the
// referred family's next subscription event, which the Stripe webhook does not
// retry for this (the reward is best-effort and never fails the event). That is
// usually the renewal, a month or a year later, long after the key is gone. So
// one transient failure became a second credit.
//
// The fake Stripe below honours idempotency keys until `forgetKeys()`, which
// stands for the 24 hours passing, and lists each customer's balance
// transactions with their metadata, as Stripe does.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rewardConvertedReferral, rewardReferral } from '@/lib/referrals/server';
import { rewardRecordFrom } from '@/lib/referrals/core';

const REFERRER = '11111111-1111-4111-8111-111111111111';
const REFERRED = '22222222-2222-4222-8222-222222222222';
const REFERRAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_REFERRAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const db = createInMemorySupabase({
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_email: null, converted_at: null, rewarded_at: null, metadata: {} },
    billing_customers: { provider: 'stripe', customer_ref: null },
  },
});
const realClient = db as unknown as SupabaseClient<Database>;

// The referral row's metadata write can be made to fail, once: the credit
// exists at Stripe and its id never reaches the row.
let failNextRewardRecord = false;
const client = new Proxy(realClient, {
  get(target, prop, receiver) {
    if (prop !== 'from') return Reflect.get(target, prop, receiver);
    return (table: string) => {
      const builder = target.from(table as never);
      if (table !== 'referrals') return builder;
      return new Proxy(builder, {
        get(b, p, r) {
          if (p !== 'update') return Reflect.get(b, p, r);
          return (values: Record<string, unknown>) => {
            if (failNextRewardRecord && 'metadata' in values && !('status' in values)) {
              failNextRewardRecord = false;
              const refused = { data: null, error: { message: 'synthetic: the row write was refused' } };
              const chain = { eq: () => chain, select: () => chain, maybeSingle: async () => refused };
              return chain;
            }
            return (b as unknown as { update: (v: unknown) => unknown }).update(values);
          };
        },
      });
    };
  },
}) as SupabaseClient<Database>;

type Txn = { id: string; customer: string; amount: number; metadata: Record<string, string> };

function fakeStripe() {
  const txns: Txn[] = [];
  const keys = new Map<string, string>();
  let n = 0;
  const control = {
    txns,
    credits: (customer: string) => txns.filter((t) => t.customer === customer && t.amount < 0),
    /** Stripe made the next credit for this customer, but the answer never arrived. */
    loseNextAnswerFor: new Set<string>(),
    listFails: false,
    pagesListed: 0,
    forgetKeys: () => keys.clear(),
  };
  const stripe = {
    customers: {
      async retrieve(id: string) { return { id, currency: 'usd' }; },
      async createBalanceTransaction(
        id: string,
        params: { amount: number; currency: string; metadata?: Record<string, string> },
        options?: { idempotencyKey?: string },
      ) {
        const key = options?.idempotencyKey;
        if (key && keys.has(key)) return { id: keys.get(key)! };
        n += 1;
        const txn = { id: `cbtxn_${n}`, customer: id, amount: params.amount, metadata: params.metadata ?? {} };
        txns.push(txn);
        if (key) keys.set(key, txn.id);
        if (control.loseNextAnswerFor.delete(id)) throw new Error('synthetic: connection reset after Stripe answered');
        return { id: txn.id };
      },
      // Newest first, `starting_after` paging, as Stripe lists them.
      async listBalanceTransactions(id: string, params?: { limit?: number; starting_after?: string }) {
        control.pagesListed += 1;
        if (control.listFails) throw new Error('synthetic Stripe outage');
        const all = txns.filter((t) => t.customer === id).reverse();
        const start = params?.starting_after ? all.findIndex((t) => t.id === params.starting_after) + 1 : 0;
        const limit = params?.limit ?? 10;
        const data = all.slice(start, start + limit).map((t) => ({ id: t.id, amount: t.amount, metadata: t.metadata }));
        return { data, has_more: start + limit < all.length };
      },
    },
  };
  return { stripe, control };
}

function seed() {
  db.seed('referrals', [{
    id: REFERRAL_ID, code: 'SMITH-7K4Q', referrer_family_id: REFERRER, referred_family_id: REFERRED,
    status: 'converted', converted_at: '2026-09-01T00:00:00Z', referrer_reward_cents: 1000, referred_reward_cents: 1000,
  }]);
  db.seed('billing_customers', [
    { family_id: REFERRER, customer_ref: 'cus_referrer' },
    { family_id: REFERRED, customer_ref: 'cus_referred' },
  ]);
}
const row = () => db.table('referrals').find((r) => r.id === REFERRAL_ID)!;

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => { db.reset(); failNextRewardRecord = false; });

describe('a credit Stripe made is not made again by a late retry', () => {
  it('when the answer was lost: the renewal months later records the credit Stripe already holds', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    control.loseNextAnswerFor.add('cus_referred');
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toMatchObject({ outcome: 'credit_failed', side: 'referred' });
    expect(control.credits('cus_referred')).toHaveLength(1);
    expect(row().status).toBe('converted');

    control.forgetKeys(); // the renewal comes a month later
    expect(await rewardConvertedReferral(client, REFERRED, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(control.credits('cus_referred'), 'the referred family is credited once').toHaveLength(1);
    expect(control.credits('cus_referrer')).toHaveLength(1);
    expect(rewardRecordFrom(row().metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_txn: 'cbtxn_2' });
    expect(row().status).toBe('rewarded');
  });

  it('when the row write failed: the late retry records the credit instead of making a second', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    failNextRewardRecord = true;
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toMatchObject({ outcome: 'persist_failed' });
    expect(control.credits('cus_referrer')).toHaveLength(1);
    expect(rewardRecordFrom(row().metadata).referrer_txn ?? null, 'the credit id never reached the row').toBeNull();

    control.forgetKeys();
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(control.credits('cus_referrer'), 'the referrer is credited once').toHaveLength(1);
    expect(control.credits('cus_referred')).toHaveLength(1);
    expect(rewardRecordFrom(row().metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_txn: 'cbtxn_2' });
  });

  it('finds the credit past the first page of the customer\'s balance history', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    failNextRewardRecord = true;
    await rewardReferral(client, REFERRAL_ID, { stripe });
    // A year of invoices drew on the balance since.
    for (let i = 0; i < 150; i++) control.txns.push({ id: `cbtxn_inv_${i}`, customer: 'cus_referrer', amount: 100, metadata: {} });
    control.forgetKeys();
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(control.credits('cus_referrer')).toHaveLength(1);
    expect(control.pagesListed).toBeGreaterThan(2);
  });
});

describe('what is not mistaken for this credit', () => {
  it('a credit for another referral, or for the other side, on the same customer', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    // The referrer was credited for an earlier referral, and once as the referred side of another.
    control.txns.push(
      { id: 'cbtxn_old', customer: 'cus_referrer', amount: -1000, metadata: { referral_id: OTHER_REFERRAL, family_id: REFERRER, side: 'referrer' } },
      { id: 'cbtxn_side', customer: 'cus_referrer', amount: -1000, metadata: { referral_id: REFERRAL_ID, family_id: REFERRER, side: 'referred' } },
    );
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(control.credits('cus_referrer')).toHaveLength(3);
    expect(rewardRecordFrom(row().metadata).referrer_txn).not.toBe('cbtxn_old');
    expect(rewardRecordFrom(row().metadata).referrer_txn).not.toBe('cbtxn_side');
  });

  it('a first reward still credits both families (control)', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(control.credits('cus_referrer')).toHaveLength(1);
    expect(control.credits('cus_referred')).toHaveLength(1);
  });
});

describe('when Stripe cannot say whether the credit exists', () => {
  it('credits nobody and leaves the side owed', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    failNextRewardRecord = true;
    await rewardReferral(client, REFERRAL_ID, { stripe });
    control.forgetKeys();
    control.listFails = true;
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(control.credits('cus_referrer')).toHaveLength(1);
    expect(control.credits('cus_referred')).toHaveLength(0);
    expect(row().status).toBe('converted');
  });

  it('credits nobody when the history is longer than it will page through', async () => {
    seed();
    const { stripe, control } = fakeStripe();
    for (let i = 0; i < 5_000; i++) control.txns.push({ id: `cbtxn_inv_${i}`, customer: 'cus_referrer', amount: 100, metadata: {} });
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(control.credits('cus_referrer')).toHaveLength(0);
  });
});
