import { describe, expect, it } from 'vitest';
import {
  normalizeTrigger,
  resolveExitIntent,
  conversionRate,
  summarizeExitIntent,
  type ExitOfferLike,
} from '@/lib/marketing/exit-intent';

describe('normalizeTrigger', () => {
  it('defaults to mouseleave with bounded values', () => {
    expect(normalizeTrigger(null)).toEqual({ mode: 'mouseleave', delayMs: 0, scrollPercent: 60 });
    expect(normalizeTrigger({ mode: 'scroll', delayMs: 999999, scrollPercent: 150 }))
      .toEqual({ mode: 'scroll', delayMs: 120000, scrollPercent: 100 });
  });
});

const offers: (ExitOfferLike & { id: string })[] = [
  { id: 'a', status: 'active', priority: 0, match: {}, created_at: '2026-01-01' },
  { id: 'b', status: 'active', priority: 5, match: { source: ['google'] }, created_at: '2026-01-02' },
  { id: 'c', status: 'paused', priority: 9, match: {}, created_at: '2026-01-03' },
];

describe('resolveExitIntent', () => {
  it('ignores paused, respects match + priority', () => {
    expect(resolveExitIntent(offers, {})?.id).toBe('a'); // b needs google, c paused
    expect(resolveExitIntent(offers, { source: 'google' })?.id).toBe('b'); // higher priority
  });
});

describe('conversionRate', () => {
  it('rounds a percentage, 0 with no impressions', () => {
    expect(conversionRate(3, 12)).toBe(25);
    expect(conversionRate(0, 0)).toBe(0);
  });
});

describe('summarizeExitIntent', () => {
  it('rolls up totals', () => {
    expect(summarizeExitIntent([
      { status: 'active', impressions: 100, conversions: 10 },
      { status: 'paused', impressions: 100, conversions: 30 },
    ])).toEqual({ offers: 2, active: 1, impressions: 200, conversions: 40, conversionRate: 20 });
  });
});
