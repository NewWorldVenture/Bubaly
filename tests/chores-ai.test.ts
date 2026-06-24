import { describe, expect, it } from 'vitest';
import {
  analyzeChores,
  buildChoresPrompt,
  parseChoresResponse,
  type ChoreEntryLike,
} from '@/lib/chores/chores-ai';

function chore(overrides: Partial<ChoreEntryLike> = {}): ChoreEntryLike {
  return { title: 'Dishes', priority: 'medium', status: 'todo', due_at: null, category: 'Kitchen', ...overrides };
}

describe('analyzeChores', () => {
  it('summarizes chores', () => {
    const r = analyzeChores([
      chore({ title: 'Dishes', status: 'todo' }),
      chore({ title: 'Vacuum', status: 'done' }),
      chore({ title: 'Laundry', status: 'in_progress' }),
    ]);
    expect(r.totalChores).toBe(3);
    expect(r.activeCount).toBe(2);
    expect(r.completedCount).toBe(1);
    expect(r.summary).toContain('3 chores');
  });

  it('detects overdue chores', () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    const r = analyzeChores([chore({ due_at: past.toISOString(), status: 'todo' })]);
    expect(r.overdueCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeChores([]);
    expect(r.totalChores).toBe(0);
    expect(r.summary).toContain('0 chores');
  });
});

describe('buildChoresPrompt', () => {
  it('builds prompt with chore info', () => {
    const { system, user } = buildChoresPrompt([chore({ title: 'Dishes', priority: 'high' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Dishes');
    expect(user).toContain('high');
  });
});

describe('parseChoresResponse', () => {
  it('parses valid JSON', () => {
    const r = parseChoresResponse('{"suggestions":["rotate chores"],"fairnessIdeas":["use points"],"organizationTip":"set reminders"}');
    expect(r.suggestions).toEqual(['rotate chores']);
    expect(r.fairnessIdeas).toEqual(['use points']);
    expect(r.organizationTip).toBe('set reminders');
  });

  it('handles malformed input', () => {
    const r = parseChoresResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseChoresResponse('```json\n{"suggestions":["x"],"fairnessIdeas":["y"],"organizationTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
