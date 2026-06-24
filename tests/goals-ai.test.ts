import { describe, expect, it } from 'vitest';
import {
  analyzeGoals,
  buildGoalsPrompt,
  parseGoalsResponse,
  type GoalEntryLike,
} from '@/lib/goals/goals-ai';

function goal(overrides: Partial<GoalEntryLike> = {}): GoalEntryLike {
  return { title: 'Save for trip', description: null, target_date: null, progress: 50, is_complete: false, ...overrides };
}

describe('analyzeGoals', () => {
  it('summarizes goals', () => {
    const r = analyzeGoals([
      goal({ progress: 75 }),
      goal({ progress: 100, is_complete: true }),
      goal({ progress: 25 }),
    ]);
    expect(r.totalGoals).toBe(3);
    expect(r.activeCount).toBe(2);
    expect(r.completedCount).toBe(1);
    expect(r.avgProgress).toBe(67);
  });

  it('handles empty list', () => {
    const r = analyzeGoals([]);
    expect(r.totalGoals).toBe(0);
    expect(r.avgProgress).toBe(0);
  });
});

describe('buildGoalsPrompt', () => {
  it('builds prompt with goal info', () => {
    const { system, user } = buildGoalsPrompt([goal({ title: 'Read 20 books', progress: 40 })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Read 20 books');
    expect(user).toContain('40%');
  });
});

describe('parseGoalsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseGoalsResponse('{"suggestions":["break into milestones"],"motivationTips":["celebrate wins"],"focusAdvice":"pick top 3"}');
    expect(r.suggestions).toEqual(['break into milestones']);
    expect(r.motivationTips).toEqual(['celebrate wins']);
    expect(r.focusAdvice).toBe('pick top 3');
  });

  it('handles malformed input', () => {
    const r = parseGoalsResponse('bad');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseGoalsResponse('```json\n{"suggestions":["x"],"motivationTips":["y"],"focusAdvice":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
