import { describe, expect, it } from 'vitest';
import {
  analyzeTodos,
  buildTodosPrompt,
  parseTodosResponse,
  type TodoEntryLike,
} from '@/lib/todos/todos-ai';

function todo(overrides: Partial<TodoEntryLike> = {}): TodoEntryLike {
  return { title: 'Buy milk', is_done: false, priority: 'medium', due_date: null, ...overrides };
}

describe('analyzeTodos', () => {
  it('summarizes todos', () => {
    const r = analyzeTodos([
      todo({ is_done: false }),
      todo({ title: 'Call dentist', is_done: true }),
    ]);
    expect(r.totalTodos).toBe(2);
    expect(r.pendingCount).toBe(1);
    expect(r.doneCount).toBe(1);
    expect(r.summary).toContain('2 todos');
  });

  it('detects overdue', () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    const r = analyzeTodos([todo({ due_date: past.toISOString().slice(0, 10) })]);
    expect(r.overdueCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeTodos([]);
    expect(r.totalTodos).toBe(0);
  });
});

describe('buildTodosPrompt', () => {
  it('builds prompt with todo info', () => {
    const { system, user } = buildTodosPrompt([todo({ title: 'Fix faucet' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Fix faucet');
  });
});

describe('parseTodosResponse', () => {
  it('parses valid JSON', () => {
    const r = parseTodosResponse('{"suggestions":["batch tasks"],"productivityTips":["time block"],"focusTip":"do quick wins first"}');
    expect(r.suggestions).toEqual(['batch tasks']);
    expect(r.productivityTips).toEqual(['time block']);
    expect(r.focusTip).toBe('do quick wins first');
  });

  it('handles malformed input', () => {
    const r = parseTodosResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });
});
