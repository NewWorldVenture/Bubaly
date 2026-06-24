import { describe, expect, it } from 'vitest';
import {
  analyzeHomework,
  buildHomeworkPrompt,
  parseHomeworkResponse,
  type HomeworkEntryLike,
} from '@/lib/homework/homework-ai';

function hw(overrides: Partial<HomeworkEntryLike> = {}): HomeworkEntryLike {
  return { title: 'Math worksheet', subject: 'Math', status: 'not_started', due_at: null, ...overrides };
}

describe('analyzeHomework', () => {
  it('summarizes assignments', () => {
    const r = analyzeHomework([
      hw({ status: 'not_started' }),
      hw({ title: 'Essay', subject: 'English', status: 'done' }),
    ]);
    expect(r.totalAssignments).toBe(2);
    expect(r.pendingCount).toBe(1);
    expect(r.completedCount).toBe(1);
    expect(r.summary).toContain('2 assignments');
  });

  it('detects overdue', () => {
    const past = new Date();
    past.setDate(past.getDate() - 2);
    const r = analyzeHomework([hw({ due_at: past.toISOString(), status: 'not_started' })]);
    expect(r.overdueCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeHomework([]);
    expect(r.totalAssignments).toBe(0);
  });
});

describe('buildHomeworkPrompt', () => {
  it('builds prompt with assignment info', () => {
    const { system, user } = buildHomeworkPrompt([hw({ title: 'Science project' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Science project');
  });
});

describe('parseHomeworkResponse', () => {
  it('parses valid JSON', () => {
    const r = parseHomeworkResponse('{"suggestions":["start early"],"studyTips":["use flashcards"],"priorityTip":"do overdue first"}');
    expect(r.suggestions).toEqual(['start early']);
    expect(r.studyTips).toEqual(['use flashcards']);
    expect(r.priorityTip).toBe('do overdue first');
  });

  it('handles malformed input', () => {
    const r = parseHomeworkResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });
});
