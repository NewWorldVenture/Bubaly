import { describe, it, expect } from 'vitest';
import {
  channelOf, creditForVisitor, attributeConversions, conversionCount,
  ATTRIBUTION_MODELS, type Touchpoint,
} from '@/lib/marketing/attribution';

const t = (visitor_id: string, source: string | null, occurred_at: string, kind: 'touch' | 'conversion' = 'touch'): Touchpoint =>
  ({ visitor_id, source, occurred_at, kind });

describe('channelOf', () => {
  it('falls back to direct', () => {
    expect(channelOf({ source: null })).toBe('direct');
    expect(channelOf({ source: '  ' })).toBe('direct');
    expect(channelOf({ source: 'google' })).toBe('google');
  });
});

describe('creditForVisitor', () => {
  const touches = [
    t('v', 'google', '2026-01-01'),
    t('v', 'email', '2026-01-02'),
    t('v', 'direct', '2026-01-03'),
    t('v', 'facebook', '2026-01-04', 'conversion'),
  ];
  it('first touch gives all credit to the first channel', () => {
    expect(creditForVisitor(touches, 'first_touch')).toEqual({ google: 1 });
  });
  it('last touch gives all credit to the last channel', () => {
    expect(creditForVisitor(touches, 'last_touch')).toEqual({ facebook: 1 });
  });
  it('linear splits credit evenly', () => {
    const c = creditForVisitor(touches, 'linear');
    expect(c.google).toBeCloseTo(0.25);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('position-based weights 40/20/40', () => {
    const c = creditForVisitor(touches, 'position_based');
    expect(c.google).toBeCloseTo(0.4);
    expect(c.facebook).toBeCloseTo(0.4);
    expect(c.email).toBeCloseTo(0.1);
    expect(c.direct).toBeCloseTo(0.1);
  });
  it('handles a single touch and empty', () => {
    expect(creditForVisitor([t('v', 'google', '2026-01-01')], 'position_based')).toEqual({ google: 1 });
    expect(creditForVisitor([], 'linear')).toEqual({});
  });
  it('orders by time regardless of input order', () => {
    const unordered = [t('v', 'b', '2026-01-02'), t('v', 'a', '2026-01-01')];
    expect(creditForVisitor(unordered, 'first_touch')).toEqual({ a: 1 });
  });
});

describe('attributeConversions', () => {
  it('only counts converting journeys and aggregates by channel', () => {
    const tps = [
      // visitor 1 converts: google → email(conversion)
      t('v1', 'google', '2026-01-01'),
      t('v1', 'email', '2026-01-02', 'conversion'),
      // visitor 2 never converts → excluded
      t('v2', 'facebook', '2026-01-01'),
    ];
    const res = attributeConversions(tps, 'linear');
    const byCh = Object.fromEntries(res.map((r) => [r.channel, r.credit]));
    expect(byCh.google).toBeCloseTo(0.5);
    expect(byCh.email).toBeCloseTo(0.5);
    expect(byCh.facebook).toBeUndefined();
  });
  it('sorts by descending credit', () => {
    const tps = [
      t('v1', 'google', '2026-01-01'), t('v1', 'google', '2026-01-02'), t('v1', 'x', '2026-01-03', 'conversion'),
    ];
    const res = attributeConversions(tps, 'first_touch');
    expect(res[0].channel).toBe('google');
  });
});

describe('conversionCount', () => {
  it('counts distinct converting visitors', () => {
    expect(conversionCount([
      t('v1', 'a', '1', 'conversion'), t('v1', 'a', '2', 'conversion'), t('v2', 'b', '1', 'conversion'), t('v3', 'c', '1'),
    ])).toBe(2);
  });
});

describe('models', () => {
  it('exposes all four', () => {
    expect(ATTRIBUTION_MODELS).toHaveLength(4);
  });
});
