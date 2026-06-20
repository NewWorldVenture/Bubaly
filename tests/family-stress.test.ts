import { describe, expect, it } from 'vitest';
import { computeStress, levelFor, type StressInput } from '@/lib/family/stress';

const calm: StressInput = {
  maxEventsPerDay: 2, backToBackPairs: 0, overdueTasks: 0, schoolDeadlines: 0,
  sportsConflicts: 0, upcomingAppointments: 0, billsDueSoon: 0,
};

describe('computeStress', () => {
  it('reports a low, zero score for a calm week', () => {
    const r = computeStress(calm);
    expect(r.score).toBe(0);
    expect(r.level).toBe('low');
    expect(r.factors).toHaveLength(0);
    expect(r.suggestions[0]).toMatch(/balanced|no rescheduling/i);
  });

  it('does not penalize days at or below the comfortable threshold', () => {
    expect(computeStress({ ...calm, maxEventsPerDay: 3 }).score).toBe(0);
    expect(computeStress({ ...calm, maxEventsPerDay: 4 }).score).toBeGreaterThan(0);
  });

  it('weights sports conflicts most heavily and surfaces them first', () => {
    const r = computeStress({ ...calm, sportsConflicts: 4 });
    expect(r.score).toBe(32); // 4 * 8
    expect(r.level).toBe('moderate');
    expect(r.factors[0].label).toBe('Sports conflicts');
    expect(r.suggestions.join(' ')).toMatch(/sports/i);
  });

  it('clamps the score at 100 for an overloaded week', () => {
    const r = computeStress({
      maxEventsPerDay: 12, backToBackPairs: 8, overdueTasks: 10, schoolDeadlines: 6,
      sportsConflicts: 5, upcomingAppointments: 4, billsDueSoon: 5, routineDisruptions: 4,
    });
    expect(r.score).toBe(100);
    expect(r.level).toBe('high');
  });

  it('sorts factors by descending impact', () => {
    const r = computeStress({ ...calm, overdueTasks: 1, sportsConflicts: 1 });
    const points = r.factors.map((f) => f.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
  });
});

describe('levelFor', () => {
  it('maps score ranges to levels', () => {
    expect(levelFor(0)).toBe('low');
    expect(levelFor(24)).toBe('low');
    expect(levelFor(25)).toBe('moderate');
    expect(levelFor(50)).toBe('elevated');
    expect(levelFor(75)).toBe('high');
    expect(levelFor(100)).toBe('high');
  });
});
