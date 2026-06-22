import { describe, it, expect } from 'vitest';
import { subjectsForTrigger, SCHEDULED_TRIGGERS } from '@/lib/marketing/automation-runner';
import type { MarketingCustomer } from '@/lib/marketing/customers';

const now = new Date('2026-06-22T00:00:00Z').getTime();
const base: MarketingCustomer = {
  familyId: 'f', name: 'Fam', ownerEmail: 'a@b.com', memberCount: 2, plan: 'free', planLabel: 'Free',
  status: 'free', lifecycle: 'active', estLtvCents: 0, createdAt: '2026-06-01T00:00:00Z', lastActivityAt: '2026-06-21T00:00:00Z',
};
const c = (over: Partial<MarketingCustomer>): MarketingCustomer => ({ ...base, ...over });

describe('subjectsForTrigger', () => {
  const customers = [
    c({ familyId: 'new', lifecycle: 'new' }),
    c({ familyId: 'inactive', lastActivityAt: '2026-04-01T00:00:00Z' }),
    c({ familyId: 'lapsed', lifecycle: 'lapsed' }),
    c({ familyId: 'vip', estLtvCents: 30000 }),
    c({ familyId: 'churned-old', lifecycle: 'churned', lastActivityAt: '2026-01-01T00:00:00Z' }),
  ];

  it('matches new customers for welcome', () => {
    expect(subjectsForTrigger('customer_created', customers, now).map((x) => x.familyId)).toEqual(['new']);
  });

  it('matches >30d inactive (excluding churned)', () => {
    const ids = subjectsForTrigger('customer_inactive', customers, now).map((x) => x.familyId);
    expect(ids).toContain('inactive');
    expect(ids).not.toContain('churned-old'); // churned excluded
  });

  it('matches lapsed for dunning and high-LTV for VIP', () => {
    expect(subjectsForTrigger('payment_failed', customers, now).map((x) => x.familyId)).toEqual(['lapsed']);
    expect(subjectsForTrigger('high_value_detected', customers, now).map((x) => x.familyId)).toEqual(['vip']);
  });

  it('returns nothing for event-driven triggers', () => {
    expect(subjectsForTrigger('form_submitted', customers, now)).toEqual([]);
    expect(subjectsForTrigger('email_opened', customers, now)).toEqual([]);
  });

  it('SCHEDULED_TRIGGERS are all handled', () => {
    for (const t of SCHEDULED_TRIGGERS) {
      expect(Array.isArray(subjectsForTrigger(t, customers, now))).toBe(true);
    }
  });
});
