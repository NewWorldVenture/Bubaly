import { describe, expect, it } from 'vitest';
import {
  tierLevel, levelTier, featureAccess, effectiveTier, isFeatureKey, FEATURES, DEFAULT_TIER,
} from '@/lib/features/catalog';

describe('tier ↔ level', () => {
  it('maps tiers to levels', () => {
    expect(tierLevel('free')).toBe(0);
    expect(tierLevel('basic')).toBe(1);
    expect(tierLevel('plus')).toBe(2);
    expect(tierLevel('off')).toBe(Infinity);
  });
  it('maps levels to tiers', () => {
    expect(levelTier(0)).toBe('free');
    expect(levelTier(1)).toBe('basic');
    expect(levelTier(2)).toBe('plus');
    expect(levelTier(null)).toBe('free');
  });
});

describe('featureAccess — the exact required semantics', () => {
  // Free feature → visible to Free(0), Basic(1), Plus(2)
  it('free shows for all tiers', () => {
    expect(featureAccess('free', 0)).toBe('visible');
    expect(featureAccess('free', 1)).toBe('visible');
    expect(featureAccess('free', 2)).toBe('visible');
  });
  // Basic feature → Basic+Plus visible, Free locked
  it('basic shows for basic+plus, locked for free', () => {
    expect(featureAccess('basic', 0)).toBe('locked');
    expect(featureAccess('basic', 1)).toBe('visible');
    expect(featureAccess('basic', 2)).toBe('visible');
  });
  // Plus feature → Plus only, Basic+Free locked
  it('plus shows for plus only, locked for basic+free', () => {
    expect(featureAccess('plus', 0)).toBe('locked');
    expect(featureAccess('plus', 1)).toBe('locked');
    expect(featureAccess('plus', 2)).toBe('visible');
  });
  // Off → hidden for everyone
  it('off is hidden for all tiers', () => {
    expect(featureAccess('off', 0)).toBe('hidden');
    expect(featureAccess('off', 1)).toBe('hidden');
    expect(featureAccess('off', 2)).toBe('hidden');
  });
  // Super admins always see everything (including Off, to preview)
  it('super admin always visible', () => {
    expect(featureAccess('off', 0, true)).toBe('visible');
    expect(featureAccess('plus', 0, true)).toBe('visible');
  });
});

describe('effectiveTier', () => {
  it('uses override when present', () => {
    expect(effectiveTier('/dashboard/chores', { '/dashboard/chores': 'plus' })).toBe('plus');
  });
  it('falls back to the code default', () => {
    const def = DEFAULT_TIER.get('/dashboard/chores');
    expect(effectiveTier('/dashboard/chores', {})).toBe(def);
    expect(effectiveTier('/dashboard/chores', null)).toBe(def);
  });
  it('ignores invalid override values', () => {
    expect(effectiveTier('/dashboard/chores', { '/dashboard/chores': 'gold' as never }))
      .toBe(DEFAULT_TIER.get('/dashboard/chores'));
  });
  it('unknown key defaults to free', () => {
    expect(effectiveTier('/nope', {})).toBe('free');
  });
});

describe('catalog', () => {
  it('includes core gated routes with sane defaults', () => {
    expect(isFeatureKey('/dashboard/chores')).toBe(true);
    expect(DEFAULT_TIER.get('/dashboard/chores')).toBe('basic');
    expect(DEFAULT_TIER.get('/dashboard/calendar')).toBe('free');
    expect(DEFAULT_TIER.get('/dashboard/command-center')).toBe('plus');
  });
  it('has no duplicate keys and no fragment routes', () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => !k.includes('#'))).toBe(true);
  });
});
