import { describe, expect, it } from 'vitest';
import {
  planMonthlyCents,
  planName,
  planById,
  FAMILY_MONTHLY_CENTS,
  FAMILY_ANNUAL_CENTS,
} from '@/lib/constants/plans';

// These guard the single billing source of truth. Slugs MUST match what the
// Stripe webhook writes ('free' | 'family' | 'family_annual'). A regression here
// previously caused annual subscriptions to be counted as $0 MRR in admin.
describe('plan pricing source of truth', () => {
  it('prices the monthly Family plan from the canonical constant', () => {
    expect(planMonthlyCents('family')).toBe(FAMILY_MONTHLY_CENTS);
    expect(FAMILY_MONTHLY_CENTS).toBe(999);
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
});
