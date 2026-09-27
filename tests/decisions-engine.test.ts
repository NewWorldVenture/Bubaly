import { describe, it, expect } from 'vitest';
import { evaluateDecision, DECISION_CRITERIA, type OptionInput, type DecisionConstraints } from '@/lib/decisions/engine';

// The engine words its hard-constraint breaches through the READER's catalogue
// and formats their money in the reader's locale, so it takes both. These cases
// assert which sentence and which amount it chose; an echo translator shows
// both without depending on the catalogue. What a reader actually sees is in
// tests/a-german-family-reads-engine-money-in-their-own-format.test.ts.
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const evaluate = (options: OptionInput[], constraints: DecisionConstraints = {}) =>
  evaluateDecision(options, constraints, 'en-US', echo);

const vacations: OptionInput[] = [
  { id: 'beach', label: 'Beach week', costCents: 180000, travelMinutes: 240, loadDelta: 30, benefit: 80 },
  { id: 'mountains', label: 'Mountain cabin', costCents: 120000, travelMinutes: 120, loadDelta: 25, benefit: 70 },
  { id: 'cruise', label: 'Cruise', costCents: 320000, travelMinutes: 300, loadDelta: 20, benefit: 90 },
];

describe('evaluateDecision', () => {
  it('ranks options and returns a recommendation', () => {
    const { ranked, recommendation } = evaluate(vacations);
    expect(ranked).toHaveLength(3);
    expect(recommendation).not.toBeNull();
    // scores are 0..100
    for (const r of ranked) expect(r.score).toBeGreaterThanOrEqual(0), expect(r.score).toBeLessThanOrEqual(100);
    // best first
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('flags budget violations and pushes infeasible options below feasible ones', () => {
    const { ranked, recommendation } = evaluate(vacations, { budgetCents: 200000 });
    const cruise = ranked.find((r) => r.id === 'cruise')!;
    expect(cruise.feasible).toBe(false);
    expect(cruise.violations[0]).toContain('decisionEngine.overBudgetBy');
    expect(cruise.violations[0]).toContain('$1,200'); // 3,200 − 2,000
    expect(cruise.rationale).toContain('decisionEngine.doesNotFit');
    // recommendation is never an infeasible option
    expect(recommendation!.feasible).toBe(true);
    expect(recommendation!.id).not.toBe('cruise');
    // infeasible sorted last
    expect(ranked[ranked.length - 1].id).toBe('cruise');
  });

  it('flags travel-limit violations', () => {
    const { ranked } = evaluate(vacations, { maxTravelMinutes: 200 });
    expect(ranked.find((r) => r.id === 'beach')!.feasible).toBe(false);
    expect(ranked.find((r) => r.id === 'cruise')!.feasible).toBe(false);
    expect(ranked.find((r) => r.id === 'mountains')!.feasible).toBe(true);
  });

  it('honours custom weights (benefit-maximizing picks the cruise when affordable)', () => {
    const { recommendation } = evaluate(vacations, {
      weights: { benefit: 10, cost: 0, travel: 0, load: 0, time: 0 },
    });
    expect(recommendation!.id).toBe('cruise'); // highest benefit
  });

  it('produces a human rationale mentioning strengths', () => {
    const { recommendation } = evaluate(vacations);
    expect(recommendation!.rationale).toMatch(/strong on/);
  });

  it('treats missing metrics as neutral (0.5) without crashing', () => {
    const opts: OptionInput[] = [{ id: 'a', label: 'A', costCents: 100 }, { id: 'b', label: 'B' }];
    const { ranked } = evaluate(opts);
    const b = ranked.find((r) => r.id === 'b')!;
    for (const c of DECISION_CRITERIA) if (c !== 'cost') expect(b.breakdown[c]).toBe(0.5);
    // A is cheaper -> should score at least as high
    expect(ranked.find((r) => r.id === 'a')!.score).toBeGreaterThanOrEqual(b.score);
  });

  it('handles a single option (no normalization range)', () => {
    const { ranked, recommendation } = evaluate([{ id: 'only', label: 'Only', costCents: 500, benefit: 60 }]);
    expect(ranked).toHaveLength(1);
    expect(recommendation!.id).toBe('only');
    expect(recommendation!.score).toBeGreaterThan(0);
  });

  it('returns empty for no options', () => {
    expect(evaluate([])).toEqual({ ranked: [], recommendation: null });
  });

  it('recommendation is null when every option is infeasible', () => {
    const { recommendation } = evaluate(
      [{ id: 'x', label: 'X', costCents: 999999, travelMinutes: 10 }],
      { budgetCents: 100 },
    );
    expect(recommendation).toBeNull();
  });
});
