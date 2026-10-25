// Admin reach N2 — a referral reward had no upper limit, so one typo in the
// admin form became a real Stripe credit to both families on every referral.
//
// /admin/marketing/referrals took dollars with min=0 and no max, the action
// multiplied by 100 and resolveReferralConfig only floored at zero. Every new
// referral row copies the amounts, and rewardReferral credits BOTH families'
// Stripe balances with them: an operator who typed 1000 meaning cents gave
// $1,000 to each side of every referral made while it stood, and correcting
// the config did not reach rows already made. The audit row kept only the new
// config, and the free-text label could promise a different amount.
//
// Driven through the REAL action, config store and reward path against the
// in-memory database (the Stripe client is a recorder). Negative controls:
// before the fix a $1,000 save was stored, a label naming $10 was saved over
// $25 rewards, the audit had no previous value, and a row holding $1,000 a side
// was credited to Stripe.
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';

const admin = vi.hoisted(() => ({ requireMarketingAdmin: vi.fn(), logMarketingAudit: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  ...admin,
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { saveReferralConfigAction } = await import('@/app/(app)/admin/marketing/referrals/actions');
const { rewardReferral } = await import('@/lib/referrals/server');
type Stripe = NonNullable<Parameters<typeof rewardReferral>[2]>['stripe'];

let db: InMemorySupabase;
const settings = () => db.table('marketing_settings').find((row) => row.key === 'referral_program')?.value;
const STORED = { enabled: true, referrerRewardCents: 1000, referredRewardCents: 1000, rewardLabel: '$10 credit' };

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ enabled: 'on', rewardLabel: '', ...fields })) fd.set(key, value);
  return fd;
}
async function refusal(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string });
  return error?.digest ?? null;
}

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('marketing_settings', [{ key: 'referral_program', value: STORED, updated_by: null }]);
  admin.requireMarketingAdmin.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  admin.logMarketingAudit.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the referral program settings', () => {
  it.each([
    ['1000', '10'], ['10', '1000'], ['100.01', '10'], ['-5', '10'], ['1e3', '10'], ['10.005', '10'], ['ten', '10'],
  ])('refuse referrer $%s / referred $%s and keep the stored amounts', async (referrer, referred) => {
    const digest = await refusal(saveReferralConfigAction(form({ referrerRewardDollars: referrer, referredRewardDollars: referred })));
    expect(digest).toBe(`${REFUSAL_DIGEST_PREFIX}invalid`);
    expect(settings()).toEqual(STORED);
    expect(admin.logMarketingAudit).not.toHaveBeenCalled();
  });

  it('refuse a label that names an amount the rewards do not pay', async () => {
    const digest = await refusal(saveReferralConfigAction(form({ referrerRewardDollars: '25', referredRewardDollars: '25', rewardLabel: '$10 credit' })));
    expect(digest).toBe(`${REFUSAL_DIGEST_PREFIX}invalid`);
    expect(settings()).toEqual(STORED);
  });

  it('save amounts within the cap, and audit what they replaced', async () => {
    await saveReferralConfigAction(form({ referrerRewardDollars: '25', referredRewardDollars: '25', rewardLabel: '$25 credit' }));
    const next = { enabled: true, referrerRewardCents: 2500, referredRewardCents: 2500, rewardLabel: '$25 credit' };
    expect(settings()).toEqual(next);
    expect(admin.logMarketingAudit).toHaveBeenCalledWith(db, expect.objectContaining({
      resource: 'referral_program', metadata: { previous: STORED, next },
    }));
    // The cap itself is allowed, and a label without a figure is not checked.
    await saveReferralConfigAction(form({ referrerRewardDollars: '100', referredRewardDollars: '0.5', rewardLabel: 'A month on us' }));
    expect(settings()).toMatchObject({ referrerRewardCents: 10_000, referredRewardCents: 50 });
  });
});

describe('a referral row made under a mistyped config', () => {
  const REFERRER = '11111111-1111-4111-8111-111111111111';
  const REFERRED = '22222222-2222-4222-8222-222222222222';
  const credits: unknown[] = [];
  const stripe = {
    customers: {
      async retrieve(id: string) { return { id, currency: 'usd' }; },
      async createBalanceTransaction(id: string, params: unknown) { credits.push({ id, params }); return { id: `cbtxn_${credits.length}` }; },
      async listBalanceTransactions() { return { data: [], has_more: false }; },
    },
  } as unknown as Stripe;

  beforeEach(() => {
    credits.length = 0;
    db.seed('billing_customers', [
      { family_id: REFERRER, provider: 'stripe', customer_ref: 'cus_referrer' },
      { family_id: REFERRED, provider: 'stripe', customer_ref: 'cus_referred' },
    ]);
  });
  const seed = (cents: number) => db.seed('referrals', [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'SMITH-7K4Q', referrer_family_id: REFERRER, referred_family_id: REFERRED,
    status: 'converted', converted_at: '2026-10-01T00:00:00Z', rewarded_at: null, metadata: {},
    referrer_reward_cents: cents, referred_reward_cents: cents,
  }]);
  const service = () => db as unknown as SupabaseClient<Database>;

  it('is not credited above the cap, and stays converted for reconciliation', async () => {
    seed(100_000);
    const result = await rewardReferral(service(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { stripe });
    expect(result).toMatchObject({ outcome: 'credit_failed', side: 'referrer' });
    expect(credits).toEqual([]);
    expect(db.table('referrals')[0]).toMatchObject({ status: 'converted' });
  });

  it('the control: a row at the cap is credited on both sides', async () => {
    seed(10_000);
    const result = await rewardReferral(service(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { stripe });
    expect(result).toMatchObject({ outcome: 'rewarded' });
    expect(credits).toHaveLength(2);
  });
});
