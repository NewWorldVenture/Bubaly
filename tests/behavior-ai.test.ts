import { describe, expect, it } from 'vitest';
import { analyzeBehavior, buildBehaviorPrompt, parseBehaviorResponse, type BehaviorEntryForAI } from '@/lib/behavior/behavior-ai';

function entry(overrides: Partial<BehaviorEntryForAI> = {}): BehaviorEntryForAI {
  return { kind: 'positive', category: 'homework', points: 5, occurred_at: '2025-06-01T10:00:00Z', ...overrides };
}

describe('analyzeBehavior', () => {
  it('summarizes entries', () => {
    const r = analyzeBehavior([entry(), entry({ kind: 'negative', points: -3 })]);
    expect(r.totalEntries).toBe(2);
    expect(r.positiveCount).toBe(1);
    expect(r.negativeCount).toBe(1);
    expect(r.totalPoints).toBe(2);
  });

  it('handles empty', () => {
    const r = analyzeBehavior([]);
    expect(r.totalEntries).toBe(0);
    expect(r.summary).toContain('No behavior');
  });
});

describe('buildBehaviorPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildBehaviorPrompt([entry()]);
    expect(system).toContain('JSON');
    expect(user).toContain('homework');
  });
});

describe('parseBehaviorResponse', () => {
  it('parses valid JSON', () => {
    const r = parseBehaviorResponse('{"suggestions":["reward consistency"],"encouragementTips":["praise effort"],"patternInsight":"mornings best"}');
    expect(r.suggestions).toEqual(['reward consistency']);
    expect(r.patternInsight).toBe('mornings best');
  });

  it('handles malformed', () => {
    expect(parseBehaviorResponse('bad').suggestions).toEqual([]);
  });
});
