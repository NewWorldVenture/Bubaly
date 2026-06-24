import { describe, expect, it } from 'vitest';
import {
  annualCostCents, monthlyCostCents, summarizeSubscriptions, isStale, wastedMonthlyCents,
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
  });
});

describe('isStale / wastedMonthlyCents', () => {
  const now = new Date('2026-06-24T00:00:00Z');
  it('flags never-used and old active subs', () => {
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: null }, 60, now)).toBe(true);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-01-01' }, 60, now)).toBe(true);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'active', last_used: '2026-06-20' }, 60, now)).toBe(false);
    expect(isStale({ cost_cents: 500, cadence: 'monthly', status: 'canceled', last_used: null }, 60, now)).toBe(false);
  });
  it('sums wasted monthly spend', () => {
    const subs: SubLike[] = [
      { cost_cents: 1500, cadence: 'monthly', status: 'active', last_used: null },     // stale
      { cost_cents: 1200, cadence: 'monthly', status: 'active', last_used: '2026-06-23' }, // fresh
    ];
    expect(wastedMonthlyCents(subs, 60, now)).toBe(1500);
  });
});
