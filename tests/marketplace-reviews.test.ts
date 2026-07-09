import { describe, it, expect } from 'vitest';
import { aggregateReviews, toTrustRatingSignals, ratingLabel, type ReviewInput } from '@/lib/marketplace/reviews';
import { computeTrustScore } from '@/lib/marketplace/trust';

const rv = (rating: number, over: Partial<ReviewInput> = {}): ReviewInput => ({ rating, ...over });

describe('aggregateReviews', () => {
  it('empty set → null average, zeroed distribution, no dimensions', () => {
    const s = aggregateReviews([]);
    expect(s.averageRating).toBeNull();
    expect(s.count).toBe(0);
    expect(s.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(ratingLabel(s)).toBe('No reviews yet');
  });

  it('averages overall, builds the star histogram, and rounds to 1 decimal', () => {
    const s = aggregateReviews([rv(5), rv(4), rv(5), rv(3)]);
    expect(s.count).toBe(4);
    expect(s.averageRating).toBe(4.3); // 17/4 = 4.25 → 4.3
    expect(s.distribution[5]).toBe(2);
    expect(s.distribution[4]).toBe(1);
    expect(s.distribution[3]).toBe(1);
    expect(ratingLabel(s)).toBe('4.3 ★ (4 reviews)');
  });

  it('ignores out-of-range stars', () => {
    const s = aggregateReviews([rv(5), rv(0), rv(6), rv(4)]);
    expect(s.count).toBe(2);
    expect(s.averageRating).toBe(4.5);
  });

  it('averages each rating dimension independently', () => {
    const s = aggregateReviews([
      rv(5, { dimensions: { communication: 5, timeliness: 4 } }),
      rv(4, { dimensions: { communication: 4 } }),
    ]);
    expect(s.byDimension.communication).toBe(4.5);
    expect(s.byDimension.timeliness).toBe(4);
    expect(s.byDimension.reliability).toBeUndefined();
  });

  it('returns the most recent reviews first, capped', () => {
    const s = aggregateReviews([
      rv(5, { createdAt: '2026-01-01', body: 'old' }),
      rv(4, { createdAt: '2026-03-01', body: 'new' }),
      rv(3, { createdAt: '2026-02-01', body: 'mid' }),
    ], { recentLimit: 2 });
    expect(s.recent.map((r) => r.body)).toEqual(['new', 'mid']);
  });
});

describe('trust bridge', () => {
  it('feeds averageRating + ratingCount into the trust engine', () => {
    const summary = aggregateReviews([rv(5), rv(5), rv(4), rv(5), rv(5)]);
    const signals = toTrustRatingSignals(summary);
    expect(signals.averageRating).toBe(4.8);
    expect(signals.ratingCount).toBe(5);
    const trust = computeTrustScore({ ...signals, completedTransactions: 10 });
    expect(trust.badges).toContain('top_rated'); // ≥4.8 mean with ≥5 reviews
  });
});
