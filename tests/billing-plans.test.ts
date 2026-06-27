import { describe, it, expect } from 'vitest';
import {
  classifyChange, slugToStripePlan, stripePlanFor, intervalOfSlug, isStripePlan,
  annualSavingsPct, PLAN_META,
} from '@/lib/billing/plans';

describe('slug ↔ stripe plan', () => {
  it('maps stored slugs to stripe plans', () => {
    expect(slugToStripePlan('free')).toBeNull();
    expect(slugToStripePlan(null)).toBeNull();
    expect(slugToStripePlan('basic')).toBe('basic_monthly');
    expect(slugToStripePlan('basic_annual')).toBe('basic_annual');
    expect(slugToStripePlan('plus')).toBe('plus_monthly');
    expect(slugToStripePlan('plus_annual')).toBe('plus_annual');
  });
  it('treats legacy family slugs as basic', () => {
    expect(slugToStripePlan('family')).toBe('basic_monthly');
    expect(slugToStripePlan('family_annual')).toBe('basic_annual');
  });
  it('stripePlanFor + interval helpers', () => {
    expect(stripePlanFor(1, 'monthly')).toBe('basic_monthly');
    expect(stripePlanFor(2, 'annual')).toBe('plus_annual');
    expect(intervalOfSlug('plus_annual')).toBe('annual');
    expect(intervalOfSlug('basic')).toBe('monthly');
    expect(isStripePlan('plus_annual')).toBe(true);
    expect(isStripePlan('gold')).toBe(false);
  });
});

describe('classifyChange', () => {
  it('Free → any paid plan is "new"', () => {
    expect(classifyChange('free', 'basic_monthly')).toBe('new');
    expect(classifyChange(null, 'plus_annual')).toBe('new');
  });
  it('same tier + interval is "current"', () => {
    expect(classifyChange('basic', 'basic_monthly')).toBe('current');
    expect(classifyChange('plus_annual', 'plus_annual')).toBe('current');
  });
  it('Basic → Plus is upgrade (regardless of interval)', () => {
    expect(classifyChange('basic', 'plus_monthly')).toBe('upgrade');
    expect(classifyChange('basic_annual', 'plus_monthly')).toBe('upgrade');
  });
  it('Plus → Basic is downgrade', () => {
    expect(classifyChange('plus', 'basic_annual')).toBe('downgrade');
    expect(classifyChange('plus_annual', 'basic_monthly')).toBe('downgrade');
  });
  it('same tier, different interval is switch_interval', () => {
    expect(classifyChange('basic', 'basic_annual')).toBe('switch_interval');
    expect(classifyChange('plus_annual', 'plus_monthly')).toBe('switch_interval');
  });
});

describe('pricing metadata', () => {
  it('annual monthly-equivalent is cheaper than monthly', () => {
    expect(PLAN_META.basic_annual.monthlyCents).toBeLessThan(PLAN_META.basic_monthly.monthlyCents);
    expect(PLAN_META.plus_annual.monthlyCents).toBeLessThan(PLAN_META.plus_monthly.monthlyCents);
  });
  it('annual savings are a sane positive percent', () => {
    expect(annualSavingsPct(1)).toBeGreaterThan(0);
    expect(annualSavingsPct(2)).toBeGreaterThan(0);
    expect(annualSavingsPct(1)).toBeLessThan(50);
  });
});
