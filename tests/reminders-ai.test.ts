import { describe, expect, it } from 'vitest';
import { analyzeReminders, buildRemindersPrompt, parseRemindersResponse, type ReminderForAI } from '@/lib/reminders/reminders-ai';

function reminder(overrides: Partial<ReminderForAI> = {}): ReminderForAI {
  return { title: 'Pick up groceries', kind: 'task', priority: 'medium', status: 'active', remind_at: '2025-07-01T10:00:00Z', recurrence: 'none', ...overrides };
}

describe('analyzeReminders', () => {
  it('summarizes reminders', () => {
    const r = analyzeReminders([reminder(), reminder({ status: 'completed' })]);
    expect(r.totalReminders).toBe(2);
    expect(r.activeCount).toBe(1);
    expect(r.completedCount).toBe(1);
  });
  it('handles empty', () => { expect(analyzeReminders([]).summary).toContain('No reminders'); });
});

describe('buildRemindersPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildRemindersPrompt([reminder()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Pick up groceries');
  });
});

describe('parseRemindersResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRemindersResponse('{"suggestions":["batch tasks"],"organizationTips":["use categories"],"priorityAdvice":"focus on urgent items"}');
    expect(r.suggestions).toEqual(['batch tasks']);
  });
  it('handles malformed', () => { expect(parseRemindersResponse('bad').suggestions).toEqual([]); });
});
