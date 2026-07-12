import { describe, it, expect } from 'vitest';
import { buildFunnel, pct, type FunnelCounts } from '@/lib/marketing/visitor-funnel';

describe('pct', () => {
  it('is 0 when the denominator is 0', () => {
    expect(pct(5, 0)).toBe(0);
  });
  it('rounds to a tenth', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 8)).toBe(12.5);
  });
});

describe('buildFunnel', () => {
  const counts: FunnelCounts = { visitors: 1000, identified: 250, profiled: 100, scored: 90, engaged: 30 };

  it('returns the five stages in order', () => {
    expect(buildFunnel(counts).map((s) => s.key)).toEqual(['visitors', 'identified', 'profiled', 'scored', 'engaged']);
  });

  it('computes share-of-top and step conversion', () => {
    const f = buildFunnel(counts);
    expect(f[0]).toMatchObject({ count: 1000, pctOfTop: 100, pctOfPrev: 100 });
    expect(f[1]).toMatchObject({ count: 250, pctOfTop: 25, pctOfPrev: 25 });      // 250/1000
    expect(f[2]).toMatchObject({ count: 100, pctOfTop: 10, pctOfPrev: 40 });      // 100/250
    expect(f[3]).toMatchObject({ count: 90, pctOfTop: 9, pctOfPrev: 90 });        // 90/100
    expect(f[4]).toMatchObject({ count: 30, pctOfTop: 3 });
    expect(f[4].pctOfPrev).toBeCloseTo(33.3, 1);                                  // 30/90
  });

  it('handles an all-zero funnel without dividing by zero', () => {
    const f = buildFunnel({ visitors: 0, identified: 0, profiled: 0, scored: 0, engaged: 0 });
    expect(f.every((s) => s.pctOfTop === 0 && s.pctOfPrev === 0 && s.count === 0)).toBe(true);
  });

  it('clamps negative counts to 0', () => {
    const f = buildFunnel({ visitors: 100, identified: -5, profiled: 0, scored: 0, engaged: 0 });
    expect(f[1].count).toBe(0);
  });
});
