import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadAdminReferralSummary } from '@/lib/referrals/admin-summary';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

const now = new Date('2026-09-09T12:00:00.000Z');
const db = createInMemorySupabase();
const client = db as unknown as SupabaseClient<Database>;
function row(n: number, overrides: Row = {}): Row {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, code: `CODE-${n}`,
    referrer_family_id: 'family-1', referred_email: null, status: 'signed_up',
    referrer_reward_cents: 1000, metadata: {}, created_at: new Date(now.getTime() - n * 60_000).toISOString(),
    ...overrides,
  };
}
function changeQueries(change: (query: ReturnType<typeof db.from>, call: number) => void) {
  const original = db.from.bind(db);
  let calls = 0;
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const query = original(table);
    change(query, ++calls);
    return query;
  });
}
beforeEach(() => { db.reset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('complete admin referral summary', () => {
  it('counts beyond the old sample and provider cap while retaining only the newest 25', async () => {
    db.seed('referrals', Array.from({ length: 1201 }, (_, i) => row(i + 1, {
      status: i < 101 ? 'converted' : 'signed_up',
      referrer_family_id: i < 101 ? 'recent-family' : 'historical-family',
    })));
    changeQueries((query) => {
      const limit = query.limit.bind(query);
      query.limit = (size) => limit(Math.min(size, 37));
    });
    const result = await loadAdminReferralSummary(client, now);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ total: 1201, converted: 101, conversionRate: 101 / 1201, unconfirmedReferrerCents: 101000 });
    expect(result.data?.topReferrers).toEqual([['historical-family', 1100], ['recent-family', 101]]);
    expect(result.data?.recent.map((r) => r.code)).toEqual(Array.from({ length: 25 }, (_, i) => `CODE-${i + 1}`));
    expect(db.log).toHaveLength(34); // 33 nonempty pages plus completion read
  });

  it('excludes future records with the same fixed cutoff across pages', async () => {
    db.seed('referrals', [row(1), row(2, { created_at: '2026-09-09T12:00:00.001Z' })]);
    const result = await loadAdminReferralSummary(client, now);
    expect(result.data).toMatchObject({ total: 1, untilIso: now.toISOString() });
  });

  it('does not skip unread records when a previously read row is deleted', async () => {
    db.seed('referrals', Array.from({ length: 501 }, (_, i) => row(i + 1)));
    changeQueries((_query, call) => { if (call === 2) db.table('referrals').splice(0, 1); });
    const result = await loadAdminReferralSummary(client, now);
    expect(result.data?.total).toBe(501);
  });

  it('uses recorded referrer settlement, independently of the referred side', async () => {
    db.seed('referrals', [
      row(1, { status: 'converted', referrer_reward_cents: 700 }),
      row(2, { status: 'rewarded', referrer_reward_cents: 900 }),
      row(3, { status: 'converted', metadata: { reward: { referrer_txn: 'cbtxn_fixture' } } }),
      row(4, { status: 'converted', referrer_reward_cents: 0, metadata: { reward: { referrer_skipped: 'zero_amount' } } }),
      row(5, { status: 'converted', referrer_reward_cents: 300, metadata: { reward: { referred_txn: 'cbtxn_fixture' } } }),
      row(6, { status: 'void' }), row(7, { status: 'pending' }), row(8, { status: 'signed_up' }),
    ]);
    const result = await loadAdminReferralSummary(client, now);
    expect(result.data).toMatchObject({ total: 8, converted: 5, conversionRate: 5 / 8, unconfirmedReferrerCents: 1000 });
  });

  it('keeps a no-referrals denominator separate from a real zero conversion rate', async () => {
    expect((await loadAdminReferralSummary(client, now)).data).toMatchObject({ total: 0, conversionRate: null, unconfirmedReferrerCents: 0 });
    db.seed('referrals', [row(1)]);
    expect((await loadAdminReferralSummary(client, now)).data?.conversionRate).toBe(0);
  });

  it.each(['transport', 'error', 'missing'])('rejects incomplete late pages (%s)', async (kind) => {
    db.seed('referrals', Array.from({ length: 501 }, (_, i) => row(i + 1)));
    changeQueries((query, call) => {
      if (call !== 2) return;
      query.then = ((resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => kind === 'transport'
        ? Promise.reject(new Error('offline')).then(resolve, reject)
        : Promise.resolve(resolve({ data: null, error: kind === 'error' ? { message: 'offline' } : null }))) as typeof query.then;
    });
    const result = await loadAdminReferralSummary(client, now);
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
  });

  it('rejects a nonadvancing provider page instead of double counting', async () => {
    db.seed('referrals', [row(1)]);
    changeQueries((query) => { query.gt = () => query; });
    expect((await loadAdminReferralSummary(client, now)).error).toBeInstanceOf(Error);
    expect(db.log).toHaveLength(2);
  });

  it.each([-1, 0.5, null, Number.NaN])('keeps a malformed unsettled amount unavailable (%s)', async (amount) => {
    db.seed('referrals', [row(1, { status: 'converted', referrer_reward_cents: amount })]);
    expect((await loadAdminReferralSummary(client, now)).data).toBeNull();
  });

  it('orders timestamp and ranking ties deterministically', async () => {
    db.seed('referrals', [row(1, { referrer_family_id: 'family-b', created_at: now.toISOString() }), row(2, { referrer_family_id: 'family-a', created_at: now.toISOString() })]);
    const result = await loadAdminReferralSummary(client, now);
    expect(result.data?.topReferrers).toEqual([['family-a', 1], ['family-b', 1]]);
    expect(result.data?.recent.map((r) => r.code)).toEqual(['CODE-2', 'CODE-1']);
  });
});
