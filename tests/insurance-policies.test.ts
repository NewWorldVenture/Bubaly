import { describe, expect, it } from 'vitest';
import {
  POLICY_TYPES, PREMIUM_FREQUENCIES, policyTypeMeta, frequencyMeta,
  annualPremium, dayDiff, renewalUrgency, upcomingRenewals,
  totalAnnualPremium, premiumByType, coverageGaps, ESSENTIAL_COVERAGE,
  insuranceSummary, fmtMoney, type PolicyLike,
} from '@/lib/insurance/policies';

const TODAY = new Date('2026-06-24T09:00:00');

function pol(p: Partial<PolicyLike> & { id: string }): PolicyLike {
  return { policy_type: 'auto', insurer: 'Acme', premium_amount: null, premium_frequency: 'monthly', renewal_date: null, ...p };
}

describe('catalogs', () => {
  it('has 12 policy types and 4 frequencies', () => {
    expect(POLICY_TYPES).toHaveLength(12);
    expect(PREMIUM_FREQUENCIES).toHaveLength(4);
    expect(policyTypeMeta('health').emoji).toBe('🩺');
    expect(policyTypeMeta('nope' as never).value).toBe('other');
    expect(frequencyMeta('annual').perYear).toBe(1);
  });
});

describe('annualPremium', () => {
  it('annualizes by frequency', () => {
    expect(annualPremium(100, 'monthly')).toBe(1200);
    expect(annualPremium(300, 'quarterly')).toBe(1200);
    expect(annualPremium(600, 'semiannual')).toBe(1200);
    expect(annualPremium(1200, 'annual')).toBe(1200);
  });
  it('treats missing/negative as zero', () => {
    expect(annualPremium(null, 'monthly')).toBe(0);
    expect(annualPremium(-5, 'monthly')).toBe(0);
  });
});

describe('dayDiff + renewalUrgency', () => {
  it('classifies lapsed / due soon / upcoming / none', () => {
    expect(dayDiff('2026-06-24', '2026-07-24')).toBe(30);
    expect(renewalUrgency('2026-06-10', TODAY)).toBe('lapsed');
    expect(renewalUrgency('2026-07-10', TODAY)).toBe('due_soon');
    expect(renewalUrgency('2026-12-10', TODAY)).toBe('upcoming');
    expect(renewalUrgency(null, TODAY)).toBe('none');
  });
});

describe('upcomingRenewals', () => {
  it('returns dated policies soonest-first', () => {
    const policies = [
      pol({ id: 'a', renewal_date: '2026-09-01' }),
      pol({ id: 'b', renewal_date: '2026-06-15' }),
      pol({ id: 'c', renewal_date: null }),
    ];
    const r = upcomingRenewals(policies, TODAY);
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r[0].urgency).toBe('lapsed');
  });
});

describe('totals and rollups', () => {
  it('sums annualized premium across policies', () => {
    const policies = [
      pol({ id: 'a', premium_amount: 100, premium_frequency: 'monthly' }), // 1200
      pol({ id: 'b', premium_amount: 600, premium_frequency: 'annual', policy_type: 'home' }), // 600
    ];
    expect(totalAnnualPremium(policies)).toBe(1800);
  });
  it('rolls up premium by type, largest first', () => {
    const policies = [
      pol({ id: 'a', premium_amount: 50, premium_frequency: 'monthly', policy_type: 'health' }), // 600
      pol({ id: 'b', premium_amount: 200, premium_frequency: 'monthly', policy_type: 'auto' }), // 2400
    ];
    const rollup = premiumByType(policies);
    expect(rollup[0].type).toBe('auto');
    expect(rollup[0].annual).toBe(2400);
    expect(rollup[1].type).toBe('health');
  });
});

describe('coverageGaps', () => {
  it('reports essential coverage the family lacks', () => {
    const policies = [pol({ id: 'a', policy_type: 'health' }), pol({ id: 'b', policy_type: 'auto' })];
    const gaps = coverageGaps(policies);
    expect(gaps).toContain('home');
    expect(gaps).toContain('life');
    expect(gaps).not.toContain('health');
    expect(ESSENTIAL_COVERAGE).toEqual(['health', 'auto', 'home', 'life']);
  });
  it('is empty when all essentials are covered', () => {
    const policies = ESSENTIAL_COVERAGE.map((t, i) => pol({ id: `p${i}`, policy_type: t }));
    expect(coverageGaps(policies)).toEqual([]);
  });
});

describe('insuranceSummary', () => {
  it('summarizes spend, lapsed, due-soon, gaps', () => {
    const policies = [
      pol({ id: 'a', policy_type: 'health', premium_amount: 100, premium_frequency: 'monthly', renewal_date: '2026-06-10' }), // lapsed, 1200/yr
      pol({ id: 'b', policy_type: 'auto', premium_amount: 50, premium_frequency: 'monthly', renewal_date: '2026-07-10' }), // due soon, 600/yr
    ];
    const s = insuranceSummary(policies, TODAY);
    expect(s.count).toBe(2);
    expect(s.annualPremium).toBe(1800);
    expect(s.monthlyPremium).toBe(150);
    expect(s.lapsed).toBe(1);
    expect(s.dueSoon).toBe(1);
    expect(s.gaps).toContain('home');
    expect(s.gaps).toContain('life');
    expect(s.text).toContain('1 lapsed');
  });
  it('handles empty + all-active', () => {
    expect(insuranceSummary([], TODAY).text).toBe('No policies yet');
    const allEssentials = ESSENTIAL_COVERAGE.map((t, i) => pol({ id: `p${i}`, policy_type: t }));
    expect(insuranceSummary(allEssentials, TODAY).text).toBe('All policies active');
  });
});

describe('fmtMoney', () => {
  it('formats whole-dollar currency and dashes for null', () => {
    expect(fmtMoney(1200)).toBe('$1,200');
    expect(fmtMoney(null)).toBe('—');
  });
});
