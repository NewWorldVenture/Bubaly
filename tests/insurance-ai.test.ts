import { describe, expect, it } from 'vitest';
import { analyzeInsurance, buildInsurancePrompt, parseInsuranceResponse, type InsurancePolicyForAI } from '@/lib/insurance/insurance-ai';

function policy(overrides: Partial<InsurancePolicyForAI> = {}): InsurancePolicyForAI {
  return { policy_type: 'auto', insurer: 'State Farm', premium_amount: 150, premium_frequency: 'monthly', coverage_amount: 50000, deductible: 500, renewal_date: null, ...overrides };
}

describe('analyzeInsurance', () => {
  it('summarizes policies', () => {
    const r = analyzeInsurance([policy(), policy({ policy_type: 'home', premium_amount: 200 })]);
    expect(r.totalPolicies).toBe(2);
    expect(r.totalPremium).toBe(350);
    expect(r.totalCoverage).toBe(100000);
  });
  it('handles empty', () => {
    expect(analyzeInsurance([]).summary).toContain('No insurance');
  });
});

describe('buildInsurancePrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildInsurancePrompt([policy()]);
    expect(system).toContain('JSON');
    expect(user).toContain('State Farm');
  });
});

describe('parseInsuranceResponse', () => {
  it('parses valid JSON', () => {
    const r = parseInsuranceResponse('{"suggestions":["bundle policies"],"coverageTips":["increase liability"],"savingsTip":"compare annually"}');
    expect(r.suggestions).toEqual(['bundle policies']);
    expect(r.savingsTip).toBe('compare annually');
  });
  it('handles malformed', () => {
    expect(parseInsuranceResponse('bad').suggestions).toEqual([]);
  });
});
