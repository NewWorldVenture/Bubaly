import { describe, it, expect } from 'vitest';
import {
  tierToLevel, isFeatureTier, resolveFeatureTiers, isFeatureAvailable,
  featuresIncludedInPlan, featuresAtTier, overridesFromResolved, TIER_ORDER,
} from '@/lib/features/tiers';
import { FEATURE_CATALOG, FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';

describe('tierToLevel', () => {
  it('maps tiers to plan levels', () => {
    expect(tierToLevel('free')).toBe(0);
    expect(tierToLevel('basic')).toBe(1);
    expect(tierToLevel('plus')).toBe(2);
    expect(tierToLevel('off')).toBe(-1);
  });
});

describe('isFeatureTier', () => {
  it('validates tiers', () => {
    expect(TIER_ORDER.every(isFeatureTier)).toBe(true);
    expect(isFeatureTier('premium')).toBe(false);
  });
});

describe('resolveFeatureTiers', () => {
  it('uses defaults when no overrides', () => {
    const r = resolveFeatureTiers(null);
    expect(r['calendar']).toBe('free');
    expect(r['daily-briefing']).toBe('plus');
    expect(Object.keys(r).length).toBe(FEATURE_CATALOG.length);
  });
  it('applies valid overrides, ignores invalid + unknown keys', () => {
    const r = resolveFeatureTiers({ calendar: 'basic', recipes: 'off', 'not-a-feature': 'plus', 'ai-assistant': 'nope' } as never);
    expect(r['calendar']).toBe('basic');
    expect(r['recipes']).toBe('off');
    expect(r['not-a-feature']).toBeUndefined();
    expect(r['ai-assistant']).toBe(FEATURE_CATALOG_BY_KEY['ai-assistant'].defaultTier); // invalid ignored
  });
});

describe('isFeatureAvailable', () => {
  it('off is never available', () => {
    expect(isFeatureAvailable('off', 2)).toBe(false);
  });
  it('respects plan level thresholds', () => {
    expect(isFeatureAvailable('free', 0)).toBe(true);
    expect(isFeatureAvailable('basic', 0)).toBe(false);
    expect(isFeatureAvailable('basic', 1)).toBe(true);
    expect(isFeatureAvailable('plus', 1)).toBe(false);
    expect(isFeatureAvailable('plus', 2)).toBe(true);
  });
});

describe('featuresIncludedInPlan', () => {
  const resolved = resolveFeatureTiers(null);
  it('free plan only includes free features', () => {
    const free = featuresIncludedInPlan(resolved, 'free');
    expect(free.every((f) => f.defaultTier === 'free')).toBe(true);
    expect(free.some((f) => f.key === 'calendar')).toBe(true);
  });
  it('plus plan includes everything that is not off', () => {
    const plus = featuresIncludedInPlan(resolved, 'plus');
    expect(plus.length).toBe(FEATURE_CATALOG.length); // nothing off by default
  });
  it('an off override removes a feature from every plan', () => {
    const r = resolveFeatureTiers({ recipes: 'off' });
    expect(featuresIncludedInPlan(r, 'plus').some((f) => f.key === 'recipes')).toBe(false);
  });
});

describe('featuresAtTier', () => {
  it('returns features exactly at the tier', () => {
    const resolved = resolveFeatureTiers(null);
    expect(featuresAtTier(resolved, 'plus').some((f) => f.key === 'daily-briefing')).toBe(true);
    expect(featuresAtTier(resolved, 'free').some((f) => f.key === 'daily-briefing')).toBe(false);
  });
});

describe('overridesFromResolved', () => {
  it('keeps only non-default tiers', () => {
    const r = resolveFeatureTiers({ calendar: 'basic' });
    const diff = overridesFromResolved(r);
    expect(diff).toEqual({ calendar: 'basic' });
  });
});
