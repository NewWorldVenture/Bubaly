import { describe, it, expect } from 'vitest';
import { isPaidActive, isNewPaidConversion, isChurn } from '@/lib/billing/conversion';

describe('isPaidActive', () => {
  it('is true only for a non-free, active plan', () => {
    expect(isPaidActive({ plan: 'plus', status: 'active' })).toBe(true);
    expect(isPaidActive({ plan: 'basic_annual', status: 'active' })).toBe(true);
    expect(isPaidActive({ plan: 'free', status: 'active' })).toBe(false);
    expect(isPaidActive({ plan: 'plus', status: 'trialing' })).toBe(false);
    expect(isPaidActive({ plan: 'plus', status: 'past_due' })).toBe(false);
    expect(isPaidActive({ plan: null, status: 'active' })).toBe(false);
  });
});

describe('isNewPaidConversion', () => {
  it('fires when crossing into paid+active from a non-paid state', () => {
    expect(isNewPaidConversion(null, { plan: 'plus', status: 'active' })).toBe(true);
    expect(isNewPaidConversion({ plan: 'free', status: 'trialing' }, { plan: 'plus', status: 'active' })).toBe(true);
    expect(isNewPaidConversion({ plan: 'plus', status: 'trialing' }, { plan: 'plus', status: 'active' })).toBe(true);
    expect(isNewPaidConversion({ plan: 'plus', status: 'past_due' }, { plan: 'plus', status: 'active' })).toBe(true); // reactivation
  });

  it('does NOT fire on renewals (already paid+active)', () => {
    expect(isNewPaidConversion({ plan: 'plus', status: 'active' }, { plan: 'plus', status: 'active' })).toBe(false);
    expect(isNewPaidConversion({ plan: 'basic', status: 'active' }, { plan: 'plus', status: 'active' })).toBe(false); // upgrade between paid tiers
  });

  it('does NOT fire when the new state is not paid+active', () => {
    expect(isNewPaidConversion({ plan: 'free', status: 'trialing' }, { plan: 'free', status: 'trialing' })).toBe(false);
    expect(isNewPaidConversion(null, { plan: 'plus', status: 'trialing' })).toBe(false);
    expect(isNewPaidConversion(null, { plan: 'free', status: 'active' })).toBe(false);
  });
});

describe('isChurn', () => {
  it('fires when a paying family cancels or downgrades to free', () => {
    expect(isChurn({ plan: 'plus', status: 'active' }, { plan: 'plus', status: 'canceled' })).toBe(true);
    expect(isChurn({ plan: 'plus', status: 'active' }, { plan: 'free', status: 'active' })).toBe(true); // downgrade
    expect(isChurn({ plan: 'basic', status: 'active' }, { plan: 'basic', status: 'unpaid' })).toBe(true);
    expect(isChurn({ plan: 'plus', status: 'active' }, { plan: 'plus', status: 'incomplete_expired' })).toBe(true);
  });

  it('does NOT fire on transient past_due (dunning may recover)', () => {
    expect(isChurn({ plan: 'plus', status: 'active' }, { plan: 'plus', status: 'past_due' })).toBe(false);
  });

  it('does NOT fire on a tier change that stays paid+active', () => {
    expect(isChurn({ plan: 'plus', status: 'active' }, { plan: 'basic', status: 'active' })).toBe(false);
    expect(isChurn({ plan: 'basic', status: 'active' }, { plan: 'plus', status: 'active' })).toBe(false);
  });

  it('does NOT fire when they were never a paying customer', () => {
    expect(isChurn(null, { plan: 'plus', status: 'canceled' })).toBe(false);
    expect(isChurn({ plan: 'free', status: 'trialing' }, { plan: 'free', status: 'canceled' })).toBe(false);
    expect(isChurn({ plan: 'plus', status: 'trialing' }, { plan: 'plus', status: 'canceled' })).toBe(false);
  });
});
