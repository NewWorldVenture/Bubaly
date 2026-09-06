import { describe, it, expect } from 'vitest';
import { computeReadiness, bandFor } from '@/lib/readiness/score';

const base = { choresOverdue: 0, remindersOverdue: 0, mealsPlanned: 0, eventsUpcoming: 0, activeMembers: 1 };

describe('bandFor', () => {
  it('maps scores to bands', () => {
    expect(bandFor(90)).toBe('great');
    expect(bandFor(65)).toBe('good');
    expect(bandFor(45)).toBe('attention');
    expect(bandFor(20)).toBe('at_risk');
  });
});

describe('computeReadiness', () => {
  it('rewards planning', () => {
    const r = computeReadiness({ ...base, mealsPlanned: 7, eventsUpcoming: 3, activeMembers: 3 });
    expect(r.score).toBe(100); // 70 +14 +8 +8 = 100
    expect(r.band).toBe('great');
  });

  it('penalizes overdue items and clamps at 0', () => {
    const r = computeReadiness({ ...base, choresOverdue: 20, remindersOverdue: 20 });
    expect(r.score).toBeLessThan(50);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.factors.some((f) => !f.good && f.label.includes('overdue chore'))).toBe(true);
  });

  it('flags no meals planned as a factor', () => {
    const r = computeReadiness(base);
    expect(r.factors.some((f) => f.label.includes('No meals planned'))).toBe(true);
  });

  it('orders factors by magnitude', () => {
    const r = computeReadiness({ ...base, choresOverdue: 5, mealsPlanned: 1 });
    expect(Math.abs(r.factors[0].delta)).toBeGreaterThanOrEqual(Math.abs(r.factors[1].delta));
  });
});
