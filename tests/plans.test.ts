import { describe, expect, it } from 'vitest';
import {
  planMonthlyCents,
  planName,
  planById,
  tierLabelForLevel,
  FAMILY_MONTHLY_CENTS,
  FAMILY_ANNUAL_CENTS,
  BASIC_MONTHLY_CENTS,
  BASIC_ANNUAL_CENTS,
  PLUS_MONTHLY_CENTS,
  PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';
import FAMILY_PRICES from '@/lib/constants/family-prices.json';
import { annualSavingsPct } from '@/lib/billing/plans';

// These guard the single billing source of truth. Slugs MUST match what the
// Stripe webhook writes ('free' | 'family' | 'family_annual'). A regression here
// previously caused annual subscriptions to be counted as $0 MRR in admin.
describe('plan pricing source of truth', () => {
  it.each([
    { name: 'Family Basic', slug: 'basic', annualSlug: 'basic_annual', level: 1 as const, monthly: BASIC_MONTHLY_CENTS, annual: BASIC_ANNUAL_CENTS, expectedMonthly: 1204, expectedAnnual: 11988, equivalent: 999 },
    { name: 'Family+', slug: 'plus', annualSlug: 'plus_annual', level: 2 as const, monthly: PLUS_MONTHLY_CENTS, annual: PLUS_ANNUAL_CENTS, expectedMonthly: 3011, expectedAnnual: 29988, equivalent: 2499 },
  ])('$name keeps the annual commitment and monthly equivalent exact', ({ slug, annualSlug, monthly, annual, expectedMonthly, expectedAnnual, equivalent }) => {
    expect(annual).toBe(expectedAnnual);
    expect(annual / 12).toBe(equivalent);
    expect(annual % 12).toBe(0);
    expect(planMonthlyCents(annualSlug)).toBe(equivalent);
    expect(monthly).toBe(expectedMonthly);
    expect(planMonthlyCents(slug)).toBe(expectedMonthly);
    expect(planById(slug)?.priceMonthly).toBe(expectedMonthly);
  });

  it.each([
    { name: 'Family Basic', level: 1 as const, monthly: BASIC_MONTHLY_CENTS, annual: BASIC_ANNUAL_CENTS },
    { name: 'Family+', level: 2 as const, monthly: PLUS_MONTHLY_CENTS, annual: PLUS_ANNUAL_CENTS },
  ])('$name monthly billing reverses the 17% annual discount with cent rounding', ({ level, monthly, annual }) => {
    expect(FAMILY_PRICES.annualSavingsPercent).toBe(17);
    const exactMonthlyCents = (annual / 12) / (1 - 17 / 100);
    expect(monthly).toBe(Math.round(exactMonthlyCents));
    expect(Math.abs(monthly - exactMonthlyCents)).toBeLessThanOrEqual(0.5);
    expect(Math.round((1 - annual / (monthly * 12)) * 100)).toBe(17);
    expect(annualSavingsPct(level)).toBe(17);
  });

  it('keeps legacy Family constants and monthly-equivalent slugs aligned with Family Basic', () => {
    expect(FAMILY_MONTHLY_CENTS).toBe(BASIC_MONTHLY_CENTS);
    expect(FAMILY_ANNUAL_CENTS).toBe(BASIC_ANNUAL_CENTS);
    expect(planMonthlyCents('family')).toBe(planMonthlyCents('basic'));
    expect(planMonthlyCents('family_annual')).toBe(planMonthlyCents('basic_annual'));
    expect(planMonthlyCents('family_annual')).toBe(999);
    expect(planById('family')).toBe(planById('basic'));
  });

  it('prices the monthly Family plan from the canonical constant', () => {
    expect(planMonthlyCents('family')).toBe(FAMILY_MONTHLY_CENTS);
    expect(FAMILY_MONTHLY_CENTS).toBe(1204);
  });

  it('prices annual as a non-zero monthly-equivalent (not $0)', () => {
    const annual = planMonthlyCents('family_annual');
    expect(annual).toBeGreaterThan(0);
    expect(annual).toBe(Math.round(FAMILY_ANNUAL_CENTS / 12));
  });

  it('annual is cheaper per month than monthly (the advertised saving)', () => {
    expect(planMonthlyCents('family_annual')).toBeLessThan(planMonthlyCents('family'));
  });

  it('treats free / unknown / null as $0 MRR', () => {
    expect(planMonthlyCents('free')).toBe(0);
    expect(planMonthlyCents('legacy_plan')).toBe(0);
    expect(planMonthlyCents(null)).toBe(0);
  });

  it('resolves human labels for every real slug and falls back safely', () => {
    expect(planName('basic')).toBe('Family Basic');
    expect(planName('plus')).toBe('Family+');
    expect(planName('family')).toBe('Family Basic'); // legacy alias for basic
    expect(planName('free')).toBe('Bubaly Free');
    expect(planName(null)).toBe('Free');
    expect(planName('mystery')).toBe('mystery');
  });

  it('exposes the current tiers and rejects unknown slugs', () => {
    expect(planById('basic')).toBeDefined();
    expect(planById('plus')).toBeDefined();
    expect(planById('family')).toBeDefined(); // legacy alias resolves to basic
    expect(planById('family_plus')).toBeUndefined(); // never a real tier
  });

  it('maps plan level to a tier label for the account widget', () => {
    expect(tierLabelForLevel(0)).toBe('Free Tier');
    expect(tierLabelForLevel(1)).toBe('Basic Tier');
    expect(tierLabelForLevel(2)).toBe('Plus Tier');
    expect(tierLabelForLevel(99)).toBe('Free Tier'); // safe fallback
  });
});
