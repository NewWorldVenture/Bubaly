import { describe, expect, it } from 'vitest';
import { analyzeUtilities, buildUtilitiesPrompt, parseUtilitiesResponse, type UtilityBillForAI } from '@/lib/utilities/utilities-ai';

function bill(overrides: Partial<UtilityBillForAI> = {}): UtilityBillForAI {
  return { kind: 'electric', provider: 'City Power', amount_cents: 15000, period_month: '2025-06', ...overrides };
}

describe('analyzeUtilities', () => {
  it('summarizes bills', () => {
    const r = analyzeUtilities([bill(), bill({ kind: 'water', amount_cents: 5000 })]);
    expect(r.totalBills).toBe(2);
    expect(r.totalCost).toBe(20000);
  });
  it('handles empty', () => { expect(analyzeUtilities([]).summary).toContain('No utility'); });
});

describe('buildUtilitiesPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildUtilitiesPrompt([bill()]);
    expect(system).toContain('JSON');
    expect(user).toContain('electric');
  });
});

describe('parseUtilitiesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseUtilitiesResponse('{"suggestions":["compare rates"],"savingsTips":["use LED bulbs"],"efficiencyTip":"insulate your attic"}');
    expect(r.suggestions).toEqual(['compare rates']);
  });
  it('handles malformed', () => { expect(parseUtilitiesResponse('bad').suggestions).toEqual([]); });
});
