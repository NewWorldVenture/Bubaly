import { describe, it, expect } from 'vitest';
import { buildInvestCoachPrompt, parseInvestCoach } from '@/lib/invest/coach';

describe('buildInvestCoachPrompt', () => {
  const base = { childName: 'Mia', assetName: 'Clean Energy', assetDescription: 'A basket of clean-energy companies.', riskLevel: 'high', portfolioValueCents: 12300, holdingsCount: 2 };

  it('includes the child, asset, and portfolio summary', () => {
    const { user } = buildInvestCoachPrompt(base);
    expect(user).toContain('Mia');
    expect(user).toContain('Clean Energy');
    expect(user).toContain('$123.00');
    expect(user).toContain('2 different');
  });

  it('handles no asset + no holdings gracefully', () => {
    const { user } = buildInvestCoachPrompt({ ...base, assetName: null, assetDescription: null, riskLevel: null, holdingsCount: 0, portfolioValueCents: 0 });
    expect(user).toContain('No specific investment');
    expect(user).toContain('not invested');
  });

  it('forbids financial advice + return promises in the system prompt', () => {
    const { system } = buildInvestCoachPrompt(base);
    expect(system).toMatch(/NEVER tell the child/i);
    expect(system).toMatch(/NEVER promise or imply returns/i);
    expect(system).toMatch(/EDUCATIONAL/i);
  });
});

describe('parseInvestCoach', () => {
  it('parses explainer + tips', () => {
    const raw = '{"explainer":"Investing is like planting seeds.","tips":["Spread out your eggs","Be patient"]}';
    expect(parseInvestCoach(raw)).toEqual({ explainer: 'Investing is like planting seeds.', tips: ['Spread out your eggs', 'Be patient'] });
  });
  it('tolerates code fences', () => {
    expect(parseInvestCoach('```json\n{"explainer":"Hi","tips":[]}\n```')).toEqual({ explainer: 'Hi', tips: [] });
  });
  it('caps tips at 4 and drops empties', () => {
    const raw = JSON.stringify({ explainer: 'x', tips: ['a', '', 'b', 'c', 'd', 'e'] });
    expect(parseInvestCoach(raw).tips).toEqual(['a', 'b', 'c', 'd']);
  });
  it('returns empty on garbage', () => {
    expect(parseInvestCoach('no json')).toEqual({ explainer: '', tips: [] });
  });
});
