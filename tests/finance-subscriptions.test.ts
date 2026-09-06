import { describe, expect, it } from 'vitest';
import {
  annualCostCents, monthlyCostCents, summarizeSubscriptions, isStale, wastedMonthlyCents, subscriptionUsage,
  type SubLike,
} from '@/lib/finance/subscriptions';

describe('cost normalisation', () => {
  it('annual + monthly per cadence', () => {
    expect(annualCostCents(1000, 'monthly')).toBe(12000);
    expect(annualCostCents(1000, 'weekly')).toBe(52000);
    expect(annualCostCents(1200, 'quarterly')).toBe(4800);
    expect(annualCostCents(12000, 'yearly')).toBe(12000);
    expect(monthlyCostCents(12000, 'yearly')).toBe(1000);
  });
});

describe('summarizeSubscriptions', () => {
  it('counts only active/trial', () => {
    const subs: SubLike[] = [
      { cost_cents: 1500, cadence: 'monthly', status: 'active' },
      { cost_cents: 12000, cadence: 'yearly', status: 'trial' },
      { cost_cents: 999, cadence: 'monthly', status: 'canceled' },
    ];
    const s = summarizeSubscriptions(subs);
    expect(s.active).toBe(2);
    expect(s.monthlyCents).toBe(1500 + 1000);
    expect(s.annualCents).toBe(30000);
  });
});

describe('subscriptionUsage', () => {
  const now = new Date('2026-06-24T00:00:00Z');

  it.each([undefined, null, ''])('keeps missing usage unknown: %s', (last_used) => {
    expect(subscriptionUsage({ last_used }, now)).toEqual({ state: 'unknown' });
  });

  it.each(['not-a-date', ' ', '2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2026-06-20junk'])(
    'identifies invalid recorded usage without normalizing it: %s', (last_used) => {
      expect(subscriptionUsage({ last_used }, now)).toEqual({ state: 'invalid' });
    },
  );

  it('distinguishes future use from missing or invalid usage', () => {
    expect(subscriptionUsage({ last_used: '2026-06-25' }, now)).toEqual({ state: 'future' });
    expect(subscriptionUsage({ last_used: '2030-01-01' }, now)).toEqual({ state: 'future' });
  });

  it('preserves recorded dates, including today and valid leap days', () => {
    expect(subscriptionUsage({ last_used: '2026-06-20' }, now)).toEqual({ state: 'recorded', lastUsed: '2026-06-20', daysSinceUse: 4 });
    expect(subscriptionUsage({ last_used: '2026-06-24' }, now)).toEqual({ state: 'recorded', lastUsed: '2026-06-24', daysSinceUse: 0 });
    expect(subscriptionUsage({ last_used: '2024-02-29' }, now)).toMatchObject({ state: 'recorded', lastUsed: '2024-02-29' });
  });

  it('does not classify a date using an invalid clock', () => {
    expect(subscriptionUsage({ last_used: '2026-06-20' }, new Date('invalid'))).toEqual({ state: 'invalid' });
  });
});

describe('isStale / wastedMonthlyCents', () => {
  const now = new Date('2026-06-24T00:00:00Z');
  it('flags only old recorded use on active or trial subscriptions', () => {
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: null }, 60, now)).toBe(false);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-01-01' }, 60, now)).toBe(true);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-06-20' }, 60, now)).toBe(false);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'canceled', last_used: null }, 60, now)).toBe(false);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'trial', last_used: '2026-01-01' }, 60, now)).toBe(true);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'paused', last_used: '2026-01-01' }, 60, now)).toBe(false);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'canceled', last_used: '2026-01-01' }, 60, now)).toBe(false);
  });

  it('sums only the cost of live subscriptions with old recorded use for review', () => {
    const subs: SubLike[] = [
      { cost_cents: 1500, cadence: 'monthly', status: 'active', last_used: null },     // unknown
      { cost_cents: 1200, cadence: 'monthly', status: 'active', last_used: '2026-06-23' }, // fresh
      { cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-01-01' },
      { cost_cents: 12000, cadence: 'yearly', status: 'trial', last_used: '2026-01-01' },
      { cost_cents: 900, cadence: 'monthly', status: 'canceled', last_used: '2026-01-01' },
      { cost_cents: 800, cadence: 'monthly', status: 'paused', last_used: '2026-01-01' },
      { cost_cents: 700, cadence: 'monthly', status: 'active', last_used: '2026-02-30' },
      { cost_cents: 600, cadence: 'monthly', status: 'active', last_used: '2026-06-25' },
    ];
    expect(wastedMonthlyCents(subs, 60, now)).toBe(1500);
  });

  it.each([undefined, null, '', 'not-a-date', '2026-02-30', '2025-02-29', '2026-06-25'])(
    'excludes unknown, invalid and future usage from stale totals: %s', (last_used) => {
      const sub: SubLike = { cost_cents: 1500, cadence: 'monthly', status: 'active', last_used };
      expect(isStale(sub, 60, now)).toBe(false);
      expect(wastedMonthlyCents([sub], 60, now)).toBe(0);
      expect(summarizeSubscriptions([sub])).toEqual({ active: 1, monthlyCents: 1500, annualCents: 18000 });
    },
  );

  it('keeps the existing strict threshold and custom review interval for recorded use', () => {
    const sub: SubLike = { cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-04-25' };
    expect(isStale(sub, 60, now)).toBe(false);
    expect(isStale(sub, 60, new Date(now.getTime() + 1))).toBe(true);
    expect(isStale(sub, 30, now)).toBe(true);
    expect(isStale(sub, 90, now)).toBe(false);
  });

  it('leaves tracked records unchanged when calculating review costs', () => {
    const subs: SubLike[] = [
      { cost_cents: 1500, cadence: 'monthly', status: 'active' },
      { cost_cents: 12000, cadence: 'yearly', status: 'trial', last_used: '2026-01-01' },
    ];
    const before = structuredClone(subs);
    expect(wastedMonthlyCents(subs, 60, now)).toBe(1000);
    expect(subs).toEqual(before);
  });
});
