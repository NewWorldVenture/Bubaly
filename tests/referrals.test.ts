import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REFERRAL_CONFIG, resolveReferralConfig, generateReferralCode,
  normalizeCode, referralLink, summarizeReferrals,
} from '@/lib/referrals/core';

describe('referral config', () => {
  it('falls back to defaults for empty/invalid input', () => {
    expect(resolveReferralConfig(null)).toEqual(DEFAULT_REFERRAL_CONFIG);
    expect(resolveReferralConfig({})).toEqual(DEFAULT_REFERRAL_CONFIG);
  });

  it('merges and clamps provided values', () => {
    const c = resolveReferralConfig({ enabled: false, referrerRewardCents: -50, referredRewardCents: 250.7, rewardLabel: '  1 month free  ' });
    expect(c.enabled).toBe(false);
    expect(c.referrerRewardCents).toBe(0);
    expect(c.referredRewardCents).toBe(251);
    expect(c.rewardLabel).toBe('1 month free');
  });
});

describe('generateReferralCode', () => {
  it('prefixes a sanitized seed and appends 4 chars', () => {
    const code = generateReferralCode('The Smith Family!', () => 0);
    expect(code).toBe('THESM-AAAA');
  });

  it('omits the prefix when seed has no letters', () => {
    expect(generateReferralCode('123', () => 0)).toBe('AAAA');
    expect(generateReferralCode(undefined, () => 0)).toBe('AAAA');
  });

  it('excludes ambiguous characters', () => {
    const code = generateReferralCode('x', Math.random);
    expect(code).not.toMatch(/[01OI]/);
  });
});

describe('normalizeCode + referralLink', () => {
  it('uppercases and strips whitespace', () => {
    expect(normalizeCode(' smith-7k4q ')).toBe('SMITH-7K4Q');
  });
  it('builds an absolute signup link', () => {
    expect(referralLink('SMITH-7K4Q')).toBe('https://www.bubaly.com/signup?ref=SMITH-7K4Q');
    expect(referralLink('A B', 'https://x.com/')).toBe('https://x.com/signup?ref=A%20B');
  });
});

describe('summarizeReferrals', () => {
  it('counts statuses and sums earned credit from converted rows', () => {
    const s = summarizeReferrals([
      { status: 'signed_up', referrer_reward_cents: 1000, referred_reward_cents: 1000 },
      { status: 'converted', referrer_reward_cents: 1000, referred_reward_cents: 1000 },
      { status: 'rewarded', referrer_reward_cents: 1500, referred_reward_cents: 1000 },
      { status: 'pending', referrer_reward_cents: 1000, referred_reward_cents: 1000 },
    ]);
    expect(s.total).toBe(4);
    expect(s.signedUp).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.converted).toBe(2);
    expect(s.earnedCents).toBe(2500);
  });
});
