import { describe, expect, it } from 'vitest';
import {
  ratingStats, shouldRouteToPublic, stars, isReviewStatus, PUBLIC_STATUSES,
} from '@/lib/marketing/reviews';

describe('ratingStats', () => {
  it('computes average, total, distribution, positivePct', () => {
    const s = ratingStats([5, 5, 4, 3, 1]);
    expect(s.total).toBe(5);
    expect(s.average).toBe(3.6);
    expect(s.fiveStarCount).toBe(2);
    expect(s.positivePct).toBe(60); // three of five are >=4
    const five = s.distribution.find((d) => d.star === 5)!;
    expect(five.count).toBe(2);
    expect(five.pct).toBe(40);
    expect(s.distribution[0].star).toBe(5); // ordered 5..1
  });

  it('handles empty + invalid ratings', () => {
    const s = ratingStats([null, undefined, 0, 6]);
    expect(s.total).toBe(0);
    expect(s.average).toBe(0);
    expect(s.distribution).toHaveLength(5);
  });
});

describe('routing + helpers', () => {
  it('routes 4–5 star to public by default', () => {
    expect(shouldRouteToPublic(5)).toBe(true);
    expect(shouldRouteToPublic(4)).toBe(true);
    expect(shouldRouteToPublic(3)).toBe(false);
  });
  it('respects a custom threshold', () => {
    expect(shouldRouteToPublic(4, 5)).toBe(false);
    expect(shouldRouteToPublic(5, 5)).toBe(true);
  });
  it('renders star strings', () => {
    expect(stars(4)).toBe('★★★★☆');
    expect(stars(0)).toBe('☆☆☆☆☆');
    expect(stars(5)).toBe('★★★★★');
  });
  it('validates status + exposes public statuses', () => {
    expect(isReviewStatus('approved')).toBe(true);
    expect(isReviewStatus('bogus')).toBe(false);
    expect(PUBLIC_STATUSES).toContain('featured');
    expect(PUBLIC_STATUSES).not.toContain('pending');
  });
});
