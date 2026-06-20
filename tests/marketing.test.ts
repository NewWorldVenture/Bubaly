import { describe, expect, it } from 'vitest';
import { evaluateSegment, summarizeCustomers, type MarketingCustomer } from '@/lib/marketing/customers';

const NOW = new Date('2026-06-20T00:00:00Z').getTime();
const DAY = 86_400_000;

function cust(p: Partial<MarketingCustomer>): MarketingCustomer {
  return {
    familyId: p.familyId ?? Math.random().toString(36).slice(2),
    name: p.name ?? 'Fam',
    ownerEmail: p.ownerEmail ?? 'a@b.com',
    memberCount: p.memberCount ?? 2,
    plan: p.plan ?? 'family',
    planLabel: p.planLabel ?? 'FamilyOS Family',
    status: p.status ?? 'active',
    lifecycle: p.lifecycle ?? 'active',
    estLtvCents: p.estLtvCents ?? 999,
    createdAt: p.createdAt ?? new Date(NOW - 200 * DAY).toISOString(),
    lastActivityAt: p.lastActivityAt ?? new Date(NOW - 1 * DAY).toISOString(),
  };
}

describe('evaluateSegment', () => {
  const customers = [
    cust({ lifecycle: 'new', plan: 'family', estLtvCents: 999 }),
    cust({ lifecycle: 'active', plan: 'family_annual', estLtvCents: 8000 }),
    cust({ lifecycle: 'lapsed', plan: 'family', estLtvCents: 3000, lastActivityAt: new Date(NOW - 90 * DAY).toISOString() }),
    cust({ lifecycle: 'free', plan: 'free', estLtvCents: 0 }),
  ];

  it('filters by lifecycle', () => {
    expect(evaluateSegment(customers, { lifecycle: ['new', 'active'] }, NOW)).toHaveLength(2);
  });

  it('filters by plan', () => {
    expect(evaluateSegment(customers, { plans: ['free'] }, NOW)).toHaveLength(1);
  });

  it('filters by minimum estimated LTV', () => {
    const r = evaluateSegment(customers, { minLtvCents: 3000 }, NOW);
    expect(r).toHaveLength(2);
    expect(r.every((c) => c.estLtvCents >= 3000)).toBe(true);
  });

  it('filters by inactivity window', () => {
    const r = evaluateSegment(customers, { inactiveForDays: 30 }, NOW);
    expect(r).toHaveLength(1);
    expect(r[0].lifecycle).toBe('lapsed');
  });

  it('combines rules with AND semantics', () => {
    expect(evaluateSegment(customers, { lifecycle: ['active'], plans: ['family'] }, NOW)).toHaveLength(0);
    expect(evaluateSegment(customers, { lifecycle: ['active'], plans: ['family_annual'] }, NOW)).toHaveLength(1);
  });

  it('returns everyone for empty rules', () => {
    expect(evaluateSegment(customers, {}, NOW)).toHaveLength(4);
  });
});

describe('summarizeCustomers', () => {
  it('counts paying customers and lifecycle buckets', () => {
    const m = summarizeCustomers([
      cust({ lifecycle: 'new', plan: 'family' }),
      cust({ lifecycle: 'active', plan: 'family' }),
      cust({ lifecycle: 'lapsed', plan: 'family' }),
      cust({ lifecycle: 'churned', plan: 'family' }),
      cust({ lifecycle: 'free', plan: 'free' }),
    ]);
    expect(m.total).toBe(5);
    expect(m.paying).toBe(2); // new + active
    expect(m.newThisMonth).toBe(1);
    expect(m.lapsed).toBe(2); // lapsed + churned
    expect(m.estMrrCents).toBe(999 * 2); // two paying on $9.99 monthly-equivalent
    expect(m.byLifecycle.free).toBe(1);
  });
});
