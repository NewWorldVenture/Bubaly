import { describe, expect, it } from 'vitest';
import {
  planMonthlyCents, planName,
  BASIC_MONTHLY_CENTS, BASIC_ANNUAL_CENTS, PLUS_MONTHLY_CENTS, PLUS_ANNUAL_CENTS,
} from '@/lib/constants/plans';

// Guards the 3-tier model the pricing page advertises and checkout must sell.
describe('billing tiers', () => {
  it('prices Basic and Plus monthly from the source of truth', () => {
    expect(planMonthlyCents('basic')).toBe(BASIC_MONTHLY_CENTS);
    expect(planMonthlyCents('plus')).toBe(PLUS_MONTHLY_CENTS);
    expect(PLUS_MONTHLY_CENTS).toBeGreaterThan(BASIC_MONTHLY_CENTS);
  });

  it('annual is a non-zero, cheaper monthly-equivalent for each tier', () => {
    expect(planMonthlyCents('basic_annual')).toBe(Math.round(BASIC_ANNUAL_CENTS / 12));
    expect(planMonthlyCents('plus_annual')).toBe(Math.round(PLUS_ANNUAL_CENTS / 12));
    expect(planMonthlyCents('basic_annual')).toBeLessThan(planMonthlyCents('basic'));
    expect(planMonthlyCents('plus_annual')).toBeLessThan(planMonthlyCents('plus'));
  });

  it('legacy family slugs resolve to Basic (backward compatible)', () => {
    expect(planMonthlyCents('family')).toBe(BASIC_MONTHLY_CENTS);
    expect(planName('family')).toBe('Family Basic');
  });

  it('free and unknown are $0', () => {
    expect(planMonthlyCents('free')).toBe(0);
    expect(planMonthlyCents('mystery')).toBe(0);
  });
});
