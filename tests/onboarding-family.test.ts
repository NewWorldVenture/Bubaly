import { describe, expect, it } from 'vitest';
import {
  cleanGoals, cleanReferralSource, parseChildAges, householdSummary, FAMILY_GOALS, REFERRAL_SOURCES,
} from '@/lib/onboarding/family';

describe('cleanGoals', () => {
  it('keeps only known goals, de-duped and order-stable', () => {
    expect(cleanGoals(['chores', 'calendar', 'chores', 'bogus'])).toEqual(['chores', 'calendar']);
  });
  it('handles null/empty', () => {
    expect(cleanGoals(null)).toEqual([]);
    expect(cleanGoals([])).toEqual([]);
  });
  it('all catalog values are accepted', () => {
    const all = FAMILY_GOALS.map((g) => g.value);
    expect(cleanGoals(all)).toEqual(all);
  });
});

describe('cleanReferralSource', () => {
  it('passes known sources', () => {
    for (const r of REFERRAL_SOURCES) expect(cleanReferralSource(r.value)).toBe(r.value);
  });
  it('rejects unknown / empty → null', () => {
    expect(cleanReferralSource('tiktok-dance')).toBeNull();
    expect(cleanReferralSource('')).toBeNull();
    expect(cleanReferralSource(undefined)).toBeNull();
  });
});

describe('parseChildAges', () => {
  it('extracts and clamps ages from free text', () => {
    expect(parseChildAges('8, 11 and 14')).toEqual([8, 11, 14]);
    expect(parseChildAges('99, 3')).toEqual([21, 3]);
    expect(parseChildAges('')).toEqual([]);
    expect(parseChildAges(null)).toEqual([]);
  });
  it('caps at 20 entries', () => {
    expect(parseChildAges(Array(30).fill('5').join(',')).length).toBe(20);
  });
});

describe('householdSummary', () => {
  it('pluralizes and omits zero kids', () => {
    expect(householdSummary(1, 0)).toBe('1 adult');
    expect(householdSummary(2, 3)).toBe('2 adults · 3 kids');
    expect(householdSummary(2, 1)).toBe('2 adults · 1 kid');
  });
});
