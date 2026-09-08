// M39 — a converted referral credits BOTH families' Stripe customer balances
// and flips to 'rewarded' only once Stripe has confirmed both. The Stripe
// client is a recorder; the rows are the in-memory Supabase, so the test reads
// back exactly what a webhook retry would read.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rewardConvertedReferral, rewardReferral, type StripeCustomerCredits } from '@/lib/referrals/server';
import { rewardIdempotencyKey, rewardRecordFrom, rewardSidesOwed, withRewardRecord } from '@/lib/referrals/core';

const REFERRER = '11111111-1111-4111-8111-111111111111';
const REFERRED = '22222222-2222-4222-8222-222222222222';
const REFERRAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const db = createInMemorySupabase({
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_email: null, converted_at: null, rewarded_at: null, metadata: {} },
    billing_customers: { provider: 'stripe', customer_ref: null },
  },
});
const client = db as unknown as SupabaseClient<Database>;

type Credit = { customer: string; amount: number; currency: string; idempotencyKey?: string; metadata?: Record<string, string> };

function fakeStripe(opts: { deleted?: Set<string>; failFor?: Set<string> } = {}) {
  const credits: Credit[] = [];
  let n = 0;
  const stripe: StripeCustomerCredits = {
    customers: {
      async retrieve(id) {
        return opts.deleted?.has(id) ? { id, deleted: true } : { id, currency: 'usd' };
      },
      async createBalanceTransaction(id, params, options) {
        if (opts.failFor?.has(id)) throw new Error('Stripe is having a moment');
        credits.push({ customer: id, amount: params.amount, currency: params.currency, idempotencyKey: options?.idempotencyKey, metadata: params.metadata });
        n += 1;
        return { id: `cbtxn_${n}` };
      },
    },
  };
  return { stripe, credits };
}

function seedConverted(extra: Record<string, unknown> = {}) {
  db.seed('referrals', [{
    id: REFERRAL_ID, code: 'SMITH-7K4Q', referrer_family_id: REFERRER, referred_family_id: REFERRED,
    status: 'converted', converted_at: '2026-09-01T00:00:00Z', referrer_reward_cents: 1000, referred_reward_cents: 1000, ...extra,
  }]);
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => { db.reset(); });

describe('reward record helpers (pure)', () => {
  it('reads what is owed from the row metadata and merges without clobbering', () => {
    expect(rewardSidesOwed(rewardRecordFrom({}))).toEqual(['referrer', 'referred']);
    expect(rewardSidesOwed(rewardRecordFrom({ reward: { referrer_txn: 'cbtxn_1' } }))).toEqual(['referred']);
    expect(rewardSidesOwed(rewardRecordFrom({ reward: { referrer_skipped: 'zero_amount', referred_txn: 'cbtxn_2' } }))).toEqual([]);
    const merged = withRewardRecord({ email_sent_at: ['x'], reward: { referrer_txn: 'cbtxn_1' } }, { referred_txn: 'cbtxn_2' });
    expect(merged).toEqual({ email_sent_at: ['x'], reward: { referrer_txn: 'cbtxn_1', referred_txn: 'cbtxn_2', referrer_skipped: null, referred_skipped: null } });
    expect(rewardIdempotencyKey('r1', 'referrer')).toBe('referral-reward-r1-referrer');
  });
});

describe('rewardReferral', () => {
  it('credits both customers as negative balance transactions and only then marks rewarded', async () => {
    seedConverted();
    db.seed('billing_customers', [
      { family_id: REFERRER, customer_ref: 'cus_referrer' },
      { family_id: REFERRED, customer_ref: 'cus_referred' },
    ]);
    const { stripe, credits } = fakeStripe();
    const out = await rewardReferral(client, REFERRAL_ID, { stripe, now: new Date('2026-09-07T10:00:00Z') });
    expect(out).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });

    expect(credits).toEqual([
      expect.objectContaining({ customer: 'cus_referrer', amount: -1000, currency: 'usd', idempotencyKey: rewardIdempotencyKey(REFERRAL_ID, 'referrer') }),
      expect.objectContaining({ customer: 'cus_referred', amount: -1000, currency: 'usd', idempotencyKey: rewardIdempotencyKey(REFERRAL_ID, 'referred') }),
    ]);
    expect(credits[0].metadata).toMatchObject({ referral_id: REFERRAL_ID, family_id: REFERRER, side: 'referrer' });

    const row = db.table('referrals')[0];
    expect(row.status).toBe('rewarded');
    expect(row.rewarded_at).toBe('2026-09-07T10:00:00.000Z');
    expect(rewardRecordFrom(row.metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_txn: 'cbtxn_2' });
  });

  it('is idempotent: a webhook retry on a rewarded row makes no Stripe call', async () => {
    seedConverted();
    db.seed('billing_customers', [
      { family_id: REFERRER, customer_ref: 'cus_referrer' },
      { family_id: REFERRED, customer_ref: 'cus_referred' },
    ]);
    const { stripe, credits } = fakeStripe();
    await rewardReferral(client, REFERRAL_ID, { stripe });
    const again = await rewardReferral(client, REFERRAL_ID, { stripe });
    expect(again).toEqual({ outcome: 'already_rewarded', referralId: REFERRAL_ID });
    expect(credits).toHaveLength(2);
    // The webhook entry point sees nothing left to do for the family either.
    expect(await rewardConvertedReferral(client, REFERRED, { stripe })).toBeNull();
    expect(credits).toHaveLength(2);
  });

  it('leaves a family without a Stripe customer at converted, crediting nobody', async () => {
    seedConverted();
    db.seed('billing_customers', [{ family_id: REFERRED, customer_ref: 'cus_referred' }]);
    const { stripe, credits } = fakeStripe();
    const out = await rewardReferral(client, REFERRAL_ID, { stripe });
    expect(out).toEqual({ outcome: 'missing_customer', referralId: REFERRAL_ID, side: 'referrer' });
    expect(credits).toHaveLength(0);
    expect(db.table('referrals')[0].status).toBe('converted');
  });

  it('after a partial credit, the retry credits only the side still owed, then flips', async () => {
    seedConverted();
    db.seed('billing_customers', [{ family_id: REFERRER, customer_ref: 'cus_referrer' }]);
    const { stripe, credits } = fakeStripe();

    // Referred family's billing_customers row is not written yet (checkout.session.completed
    // may arrive after customer.subscription.created) and this event carried no customer.
    const first = await rewardReferral(client, REFERRAL_ID, { stripe });
    expect(first).toEqual({ outcome: 'missing_customer', referralId: REFERRAL_ID, side: 'referred' });
    expect(credits).toHaveLength(1);
    let row = db.table('referrals')[0];
    expect(row.status).toBe('converted');
    expect(rewardRecordFrom(row.metadata).referrer_txn).toBe('cbtxn_1');

    // Next subscription event: the Stripe customer comes with the subscription object.
    const second = await rewardConvertedReferral(client, REFERRED, { stripe, referredCustomerRef: 'cus_from_sub' });
    expect(second).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(credits).toHaveLength(2);
    expect(credits[1]).toMatchObject({ customer: 'cus_from_sub', amount: -1000 });
    row = db.table('referrals')[0];
    expect(row.status).toBe('rewarded');
    expect(rewardRecordFrom(row.metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_txn: 'cbtxn_2' });
  });

  it('never marks rewarded when Stripe refuses a credit', async () => {
    seedConverted();
    db.seed('billing_customers', [
      { family_id: REFERRER, customer_ref: 'cus_referrer' },
      { family_id: REFERRED, customer_ref: 'cus_referred' },
    ]);
    const { stripe, credits } = fakeStripe({ failFor: new Set(['cus_referred']) });
    const out = await rewardReferral(client, REFERRAL_ID, { stripe });
    expect(out).toMatchObject({ outcome: 'credit_failed', side: 'referred' });
    expect(credits).toHaveLength(1);
    const row = db.table('referrals')[0];
    expect(row.status).toBe('converted');
    expect(row.rewarded_at).toBeNull();
    expect(rewardRecordFrom(row.metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_txn: null });
  });

  it('treats a deleted Stripe customer as missing', async () => {
    seedConverted();
    db.seed('billing_customers', [
      { family_id: REFERRER, customer_ref: 'cus_gone' },
      { family_id: REFERRED, customer_ref: 'cus_referred' },
    ]);
    const { stripe, credits } = fakeStripe({ deleted: new Set(['cus_gone']) });
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'missing_customer', referralId: REFERRAL_ID, side: 'referrer' });
    expect(credits).toHaveLength(0);
  });

  it('only rewards a converted row; signed_up and unknown rows are left alone', async () => {
    db.seed('referrals', [{ id: REFERRAL_ID, code: 'SMITH-7K4Q', referrer_family_id: REFERRER, referred_family_id: REFERRED, status: 'signed_up', referrer_reward_cents: 1000, referred_reward_cents: 1000 }]);
    const { stripe, credits } = fakeStripe();
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'not_converted', referralId: REFERRAL_ID, status: 'signed_up' });
    expect(await rewardConvertedReferral(client, REFERRED, { stripe })).toBeNull();
    expect(await rewardReferral(client, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { stripe })).toEqual({ outcome: 'not_found', referralId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(credits).toHaveLength(0);
  });

  it('a zero-amount side is skipped rather than credited, and the row still completes', async () => {
    seedConverted({ referrer_reward_cents: 1000, referred_reward_cents: 0 });
    db.seed('billing_customers', [{ family_id: REFERRER, customer_ref: 'cus_referrer' }]);
    const { stripe, credits } = fakeStripe();
    expect(await rewardReferral(client, REFERRAL_ID, { stripe })).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(credits).toHaveLength(1);
    expect(rewardRecordFrom(db.table('referrals')[0].metadata)).toMatchObject({ referrer_txn: 'cbtxn_1', referred_skipped: 'zero_amount' });
  });
});

describe('reward wiring (source)', () => {
  const route = readFileSync('app/api/webhooks/stripe/route.ts', 'utf8');
  const server = readFileSync('lib/referrals/server.ts', 'utf8');

  it('the Stripe webhook fulfils the reward right after marking the conversion, without failing the event', () => {
    expect(route.indexOf('await markReferralConverted(supabase, familyId)')).toBeLessThan(route.indexOf('await rewardConvertedReferral(supabase, familyId'));
    expect(route).toContain("catch (e) { console.error('[referral] reward fulfilment failed', e); }");
    expect(route).toContain('referredCustomerRef');
  });

  it("'rewarded' is written only after the Stripe credit calls, guarded on the converted status", () => {
    const body = server.slice(server.indexOf('export async function rewardReferral'));
    expect(body.indexOf('createBalanceTransaction(')).toBeLessThan(body.indexOf("status: 'rewarded'"));
    const flip = body.slice(body.indexOf("status: 'rewarded'"));
    expect(flip).toContain(".eq('status', 'converted')");
    expect(body).toContain('idempotencyKey: rewardIdempotencyKey(referralId, side)');
  });
});
