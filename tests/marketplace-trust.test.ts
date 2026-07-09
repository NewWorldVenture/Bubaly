import { describe, it, expect } from 'vitest';
import { computeTrustScore, verificationScore, badgeLabel, trustTier } from '@/lib/marketplace/trust';

describe('verificationScore', () => {
  it('sums points, dedupes, and caps at 30', () => {
    expect(verificationScore(['email'])).toBe(4);
    expect(verificationScore(['email', 'email'])).toBe(4); // deduped
    expect(verificationScore(['email', 'phone', 'payment_method', 'identity', 'address', 'community'])).toBe(30); // capped
  });
});

describe('computeTrustScore', () => {
  it('a brand-new member scores low and is tier "new"', () => {
    const t = computeTrustScore({});
    expect(t.score).toBeLessThan(30);
    expect(trustTier(t.score)).toBe('new');
    expect(t.badges).not.toContain('repeat_seller');
  });

  it('a seasoned, verified, well-rated member scores high with badges', () => {
    const t = computeTrustScore({
      completedTransactions: 40, averageRating: 4.9, ratingCount: 30,
      responseMinutes: 15, disputes: 0, cancellations: 0,
      verifications: ['email', 'phone', 'payment_method', 'identity'],
    });
    expect(t.score).toBeGreaterThanOrEqual(85);
    expect(t.badges).toEqual(expect.arrayContaining(['id_verified', 'verified', 'repeat_seller', 'fast_responder', 'top_rated', 'trusted']));
    expect(trustTier(t.score)).toBe('trusted');
  });

  it('damps ratings when few reviews back them', () => {
    const few = computeTrustScore({ averageRating: 5, ratingCount: 1 });
    const many = computeTrustScore({ averageRating: 5, ratingCount: 20 });
    expect(many.breakdown.ratings).toBeGreaterThan(few.breakdown.ratings);
    expect(many.breakdown.ratings).toBe(30);
  });

  it('penalizes reliability for disputes and cancellations', () => {
    const clean = computeTrustScore({ completedTransactions: 10, disputes: 0, cancellations: 0 });
    const messy = computeTrustScore({ completedTransactions: 10, disputes: 3, cancellations: 2 });
    expect(messy.breakdown.reliability).toBeLessThan(clean.breakdown.reliability);
    expect(messy.score).toBeLessThan(clean.score);
  });

  it('gives diminishing experience returns, not unbounded', () => {
    const a = computeTrustScore({ completedTransactions: 8 });
    const b = computeTrustScore({ completedTransactions: 1000 });
    expect(b.breakdown.experience).toBeLessThanOrEqual(20);
    expect(b.breakdown.experience).toBeGreaterThan(a.breakdown.experience);
  });

  it('never leaves the 0..100 range', () => {
    const worst = computeTrustScore({ completedTransactions: 1, disputes: 50, cancellations: 50 });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});

describe('labels + tiers', () => {
  it('formats badge labels and tier thresholds', () => {
    expect(badgeLabel('fast_responder')).toBe('Fast responder');
    expect(trustTier(85)).toBe('trusted');
    expect(trustTier(60)).toBe('established');
    expect(trustTier(30)).toBe('building');
    expect(trustTier(0)).toBe('new');
  });
});
