import { describe, expect, it } from 'vitest';
import { analyzeRelocation, buildRelocationPrompt, parseRelocationResponse, type RelocationTaskForAI } from '@/lib/relocation/relocation-ai';

function task(overrides: Partial<RelocationTaskForAI> = {}): RelocationTaskForAI {
  return { title: 'Pack kitchen', status: 'pending', category: 'packing', due_date: '2025-08-01', ...overrides };
}

describe('analyzeRelocation', () => {
  it('summarizes tasks', () => {
    const r = analyzeRelocation([task(), task({ status: 'done' })]);
    expect(r.totalTasks).toBe(2);
    expect(r.completedCount).toBe(1);
    expect(r.pendingCount).toBe(1);
  });
  it('handles empty', () => { expect(analyzeRelocation([]).summary).toContain('No relocation'); });
});

describe('buildRelocationPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildRelocationPrompt([task()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Pack kitchen');
  });
});

describe('parseRelocationResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRelocationResponse('{"suggestions":["label boxes"],"movingTips":["start early"],"timelineTip":"create a checklist"}');
    expect(r.suggestions).toEqual(['label boxes']);
  });
  it('handles malformed', () => { expect(parseRelocationResponse('bad').suggestions).toEqual([]); });
});
