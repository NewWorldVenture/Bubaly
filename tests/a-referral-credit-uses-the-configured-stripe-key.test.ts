// A referral credit is a billing write, so it uses the Stripe key the billing
// routes use: Super Admin → Stripe Setup first, then the environment
// (tests/billing-uses-the-stripe-keys-the-admin-configured.test.ts). It built its
// client with getStripe(), which reads only STRIPE_SECRET_KEY, so on a deployment
// whose key is saved only in Stripe Setup every reward failed, on every event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  settings: null as Record<string, string | null> | null,
  keysUsed: [] as (string | null)[],
  credits: [] as string[],
}));

vi.mock('@/lib/stripe/settings', async () => {
  const real = await vi.importActual<typeof import('@/lib/stripe/settings')>('@/lib/stripe/settings');
  return { ...real, getStripeSettings: async () => mocks.settings };
});
vi.mock('@/lib/stripe', () => {
  const client = {
    customers: {
      retrieve: async (id: string) => ({ id, currency: 'usd' }),
      listBalanceTransactions: async () => ({ data: [], has_more: false }),
      createBalanceTransaction: async (id: string) => { mocks.credits.push(id); return { id: `cbtxn_${mocks.credits.length}` }; },
    },
  };
  return {
    getStripe: () => { throw new Error('getStripe() reads only STRIPE_SECRET_KEY; a referral credit must not use it'); },
    stripeFromKey: (key: string | null) => {
      mocks.keysUsed.push(key);
      if (!key) throw new Error('Stripe is not configured');
      return client;
    },
  };
});

const { rewardReferral } = await import('@/lib/referrals/server');

const REFERRAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const db = createInMemorySupabase({
  defaults: {
    referrals: { status: 'signed_up', source: null, referred_email: null, converted_at: null, rewarded_at: null, metadata: {} },
    billing_customers: { provider: 'stripe', customer_ref: null },
  },
});
const client = db as unknown as SupabaseClient<Database>;
const saved = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  db.reset();
  delete process.env.STRIPE_SECRET_KEY;
  mocks.settings = null; mocks.keysUsed = []; mocks.credits = [];
  db.seed('referrals', [{
    id: REFERRAL_ID, code: 'SMITH-7K4Q', referrer_family_id: '11111111-1111-4111-8111-111111111111',
    referred_family_id: '22222222-2222-4222-8222-222222222222', status: 'converted', converted_at: '2026-09-01T00:00:00Z',
    referrer_reward_cents: 1000, referred_reward_cents: 1000,
  }]);
  db.seed('billing_customers', [
    { family_id: '11111111-1111-4111-8111-111111111111', customer_ref: 'cus_referrer' },
    { family_id: '22222222-2222-4222-8222-222222222222', customer_ref: 'cus_referred' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved;
  vi.restoreAllMocks();
});

describe('the referral credit uses the configured Stripe key', () => {
  it('credits with the key saved in Stripe Setup when the environment has none', async () => {
    mocks.settings = { secret_key: 'sk_test_from_admin' };
    expect(await rewardReferral(client, REFERRAL_ID)).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(mocks.credits).toEqual(['cus_referrer', 'cus_referred']);
    expect(new Set(mocks.keysUsed)).toEqual(new Set(['sk_test_from_admin']));
  });

  it('falls back to the environment key, as the billing routes do', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_from_env';
    expect(await rewardReferral(client, REFERRAL_ID)).toEqual({ outcome: 'rewarded', referralId: REFERRAL_ID });
    expect(new Set(mocks.keysUsed)).toEqual(new Set(['sk_test_from_env']));
  });

  it('credits nobody, and says so, when no key is configured anywhere', async () => {
    expect(await rewardReferral(client, REFERRAL_ID)).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(mocks.credits).toEqual([]);
  });
});
