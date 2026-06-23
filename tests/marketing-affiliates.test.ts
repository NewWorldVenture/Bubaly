import { describe, it, expect } from 'vitest';
import {
  normalizeAffiliateCode, clampRate, commissionCents, summarizeReferrals, payoutByAffiliate,
  type ReferralLike,
} from '@/lib/marketing/affiliates';

describe('normalizeAffiliateCode', () => {
  it('uppercases and dashes', () => {
    expect(normalizeAffiliateCode('Cool Blog 2026')).toBe('COOL-BLOG-2026');
    expect(normalizeAffiliateCode('  --x--  ')).toBe('X');
  });
});

describe('clampRate', () => {
  it('clamps to 0–1 and tolerates percents', () => {
    expect(clampRate(0.25)).toBe(0.25);
    expect(clampRate(20)).toBe(0.2);
    expect(clampRate(150)).toBe(1);
    expect(clampRate(-1)).toBe(0);
    expect(clampRate(null)).toBe(0);
  });
});

describe('commissionCents', () => {
  it('computes commission at a rate', () => {
    expect(commissionCents(10_000, 0.2)).toBe(2_000);
    expect(commissionCents(9_999, 0.3)).toBe(3_000); // rounds
  });
});

const r = (affiliate_id: string, status: ReferralLike['status'], commission_cents: number): ReferralLike =>
  ({ affiliate_id, status, commission_cents });

describe('summarizeReferrals', () => {
  it('splits owed vs paid; counts conversions', () => {
    const s = summarizeReferrals([
      r('a', 'pending', 999),
      r('a', 'converted', 2_000),
      r('a', 'paid', 1_500),
      r('a', 'void', 5_000),
    ]);
    expect(s.conversions).toBe(2);
    expect(s.pendingPayoutCents).toBe(2_000);
    expect(s.paidCents).toBe(1_500);
  });
});

describe('payoutByAffiliate', () => {
  it('groups per affiliate', () => {
    const map = payoutByAffiliate([
      r('a', 'converted', 1_000), r('b', 'paid', 2_000), r('a', 'paid', 500),
    ]);
    expect(map.get('a')!.pendingPayoutCents).toBe(1_000);
    expect(map.get('a')!.paidCents).toBe(500);
    expect(map.get('b')!.paidCents).toBe(2_000);
  });
});
