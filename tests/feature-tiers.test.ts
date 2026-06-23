import { describe, it, expect } from 'vitest';
import {
  tierToLevel, isFeatureTier, resolveFeatureTiers, isFeatureAvailable,
  featuresIncludedInPlan, featuresAtTier, overridesFromResolved, TIER_ORDER,
  tiersByHref, featureAccessByTier, morePermissiveTier,
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

describe('morePermissiveTier', () => {
  it('lower level wins; available beats off', () => {
    expect(morePermissiveTier('basic', 'plus')).toBe('basic');
    expect(morePermissiveTier('free', 'basic')).toBe('free');
    expect(morePermissiveTier('off', 'plus')).toBe('plus');
    expect(morePermissiveTier('off', 'off')).toBe('off');
  });
});

describe('tiersByHref', () => {
  it('keys by route and takes the most permissive when shared', () => {
    const resolved = resolveFeatureTiers(null);
    const byHref = tiersByHref(resolved);
    // /dashboard is shared by parent + family dashboards (both free) → free
    expect(byHref['/dashboard']).toBe('free');
    expect(byHref['/dashboard/calendar']).toBe('free');
    expect(byHref['/dashboard/command-center']).toBe('plus');
  });
  it('an override flows through to the route', () => {
    const byHref = tiersByHref(resolveFeatureTiers({ calendar: 'plus' }));
    expect(byHref['/dashboard/calendar']).toBe('plus');
  });
});

describe('featureAccessByTier — exact nav semantics', () => {
  it('free shows for all, basic locks free, plus locks basic+free', () => {
    expect(featureAccessByTier('free', 0)).toBe('visible');
    expect(featureAccessByTier('basic', 0)).toBe('locked');
    expect(featureAccessByTier('basic', 1)).toBe('visible');
    expect(featureAccessByTier('plus', 1)).toBe('locked');
    expect(featureAccessByTier('plus', 2)).toBe('visible');
  });
  it('off is hidden; undefined (non-catalog) is visible; super-admin sees all', () => {
    expect(featureAccessByTier('off', 2)).toBe('hidden');
    expect(featureAccessByTier(undefined, 0)).toBe('visible');
    expect(featureAccessByTier('off', 0, true)).toBe('visible');
    expect(featureAccessByTier('plus', 0, true)).toBe('visible');
  });
});
