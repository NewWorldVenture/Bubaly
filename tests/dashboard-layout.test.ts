import { describe, it, expect } from 'vitest';
import {
  isAvailableAtTier, availableFeatures, lockedFeatures, resolvePrimary, validateLayout, addableFeatures,
} from '@/lib/dashboard/layout';
import {
  FEATURE_BY_KEY, DEFAULT_LAYOUT_BY_TIER, MAX_DASH_BUTTONS, FIXED_FEATURES, tierForPlanLevel,
} from '@/lib/dashboard/registry';

describe('registry + tier mapping', () => {
  it('maps plan levels to tiers', () => {
    expect(tierForPlanLevel(0)).toBe('free');
    expect(tierForPlanLevel(1)).toBe('basic');
    expect(tierForPlanLevel(2)).toBe('plus');
  });
  it('marks the two fixed buttons non-customizable', () => {
    expect(FIXED_FEATURES.map((f) => f.key).sort()).toEqual(['ai_assistant', 'quick_add']);
    for (const f of FIXED_FEATURES) { expect(f.isFixed).toBe(true); expect(f.isCustomizable).toBe(false); }
  });
});

describe('tier availability', () => {
  it('free sees only free features as primary; basic/plus locked are hidden', () => {
    const free = availableFeatures('free');
    expect(free.every((f) => f.requiredTier === 'free')).toBe(true);
    expect(free.some((f) => f.key === 'chores')).toBe(false);  // basic
    expect(free.some((f) => f.key === 'sports')).toBe(false);  // plus
  });
  it('basic sees free + basic, not plus', () => {
    const basic = availableFeatures('basic');
    expect(basic.some((f) => f.key === 'chores')).toBe(true);
    expect(basic.some((f) => f.key === 'sports')).toBe(false);
  });
  it('plus sees everything', () => {
    expect(isAvailableAtTier(FEATURE_BY_KEY.sports, 'plus')).toBe(true);
    expect(isAvailableAtTier(FEATURE_BY_KEY.sports, 'basic')).toBe(false);
  });
  it('lockedFeatures lists exactly the above-tier features', () => {
    expect(lockedFeatures('free').every((f) => f.requiredTier !== 'free')).toBe(true);
    expect(lockedFeatures('plus')).toHaveLength(0);
  });
});

describe('resolvePrimary', () => {
  it('uses the tier default when there is no saved layout', () => {
    const keys = resolvePrimary(null, 'free').map((f) => f.key);
    expect(keys).toEqual(DEFAULT_LAYOUT_BY_TIER.free);
  });
  it('honors a saved layout order', () => {
    const keys = resolvePrimary(['notes', 'calendar', 'wallet'], 'free').map((f) => f.key);
    expect(keys.slice(0, 3)).toEqual(['notes', 'calendar', 'wallet']);
  });
  it('drops locked features on downgrade and back-fills with free ones', () => {
    // user had plus features saved, now on free → sports/command_center removed
    const keys = resolvePrimary(['command_center', 'calendar', 'sports', 'notes'], 'free').map((f) => f.key);
    expect(keys).not.toContain('command_center');
    expect(keys).not.toContain('sports');
    expect(keys).toContain('calendar');
    expect(keys.length).toBe(MAX_DASH_BUTTONS); // gap-filled, never sparse
  });
  it('makes new features available on upgrade (addable)', () => {
    expect(addableFeatures(['calendar'], 'basic').some((f) => f.key === 'chores')).toBe(true);
    expect(addableFeatures(['calendar'], 'free').some((f) => f.key === 'chores')).toBe(false);
  });
  it('dedupes and ignores unknown keys', () => {
    const keys = resolvePrimary(['calendar', 'calendar', 'not_a_feature', 'notes'], 'free').map((f) => f.key);
    expect(keys.filter((k) => k === 'calendar')).toHaveLength(1);
    expect(keys).not.toContain('not_a_feature');
  });
  it('never exceeds the max', () => {
    expect(resolvePrimary(null, 'plus').length).toBeLessThanOrEqual(MAX_DASH_BUTTONS);
  });
});

describe('validateLayout (server-side)', () => {
  it('accepts a clean tier-valid layout', () => {
    const r = validateLayout(['calendar', 'notes', 'wallet'], 'free');
    expect(r.ok).toBe(true);
    expect(r.keys).toEqual(['calendar', 'notes', 'wallet']);
  });
  it('rejects locked features', () => {
    expect(validateLayout(['calendar', 'sports'], 'free').ok).toBe(false);  // sports is plus
    expect(validateLayout(['calendar', 'chores'], 'free').ok).toBe(false);  // chores is basic
  });
  it('rejects fixed buttons being injected', () => {
    expect(validateLayout(['quick_add', 'calendar'], 'plus').ok).toBe(false);
    expect(validateLayout(['ai_assistant'], 'plus').ok).toBe(false);
  });
  it('rejects duplicates, unknowns, non-strings, and over-long', () => {
    expect(validateLayout(['calendar', 'calendar'], 'free').ok).toBe(false);
    expect(validateLayout(['nope'], 'free').ok).toBe(false);
    expect(validateLayout([123], 'free').ok).toBe(false);
    expect(validateLayout('notarray', 'free').ok).toBe(false);
    expect(validateLayout(new Array(MAX_DASH_BUTTONS + 1).fill('calendar'), 'free').ok).toBe(false);
  });
});
