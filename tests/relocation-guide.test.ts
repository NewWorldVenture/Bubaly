import { describe, expect, it } from 'vitest';
import {
  relocationStatusMeta,
  taskProgress,
  tasksByCategory,
  dayDiff,
  daysUntilMove,
  relocationSummary,
  fmtMoney,
  fmtDate,
  type RelocationLike,
  type TaskLike,
} from '@/lib/relocation/guide';

function rel(overrides: Partial<RelocationLike> & { id: string }): RelocationLike {
  return { title: 'Move', from_location: 'NYC', to_location: 'LA', status: 'planning', target_date: null, budget: null, ...overrides };
}

function task(overrides: Partial<TaskLike> & { id: string }): TaskLike {
  return { relocation_id: 'r1', title: 'Pack', status: 'todo', category: 'Packing', due_date: null, ...overrides };
}

describe('relocationStatusMeta', () => {
  it('finds a known status', () => {
    expect(relocationStatusMeta('in_progress').label).toBe('In Progress');
  });
  it('falls back to first for unknown', () => {
    expect(relocationStatusMeta('bogus' as never).label).toBe('Researching');
  });
});

describe('taskProgress', () => {
  it('counts done / total excluding skipped', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'todo' }),
      task({ id: 'c', status: 'skipped' }),
    ];
    const p = taskProgress(tasks);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.pct).toBe(50);
  });
  it('handles empty', () => {
    expect(taskProgress([]).pct).toBe(0);
  });
});

describe('tasksByCategory', () => {
  it('groups and sorts alphabetically', () => {
    const tasks = [
      task({ id: 'a', category: 'Utilities', status: 'done' }),
      task({ id: 'b', category: 'Housing', status: 'todo' }),
      task({ id: 'c', category: 'Utilities', status: 'todo' }),
    ];
    const result = tasksByCategory(tasks);
    expect(result[0]).toEqual({ category: 'Housing', total: 1, done: 0 });
    expect(result[1]).toEqual({ category: 'Utilities', total: 2, done: 1 });
  });
  it('excludes skipped tasks', () => {
    const tasks = [task({ id: 'a', status: 'skipped' })];
    expect(tasksByCategory(tasks)).toEqual([]);
  });
});

describe('dayDiff', () => {
  it('computes positive diff', () => {
    expect(dayDiff('2026-06-01', '2026-06-10')).toBe(9);
  });
  it('computes negative diff', () => {
    expect(dayDiff('2026-06-10', '2026-06-01')).toBe(-9);
  });
});

describe('daysUntilMove', () => {
  it('returns null for no target', () => {
    expect(daysUntilMove(null)).toBeNull();
  });
  it('returns positive days', () => {
    const today = new Date(2026, 5, 1);
    expect(daysUntilMove('2026-06-15', today)).toBe(14);
  });
});

describe('relocationSummary', () => {
  it('handles empty', () => {
    const s = relocationSummary([]);
    expect(s.text).toBe('No relocations planned');
    expect(s.count).toBe(0);
  });
  it('reports active count', () => {
    const list = [rel({ id: 'a', status: 'in_progress' }), rel({ id: 'b', status: 'completed' })];
    const s = relocationSummary(list);
    expect(s.active).toBe(1);
    expect(s.text).toContain('1 active');
  });
  it('reports days until next move', () => {
    const today = new Date(2026, 5, 1);
    const list = [rel({ id: 'a', status: 'planning', target_date: '2026-06-20' })];
    const s = relocationSummary(list, today);
    expect(s.text).toContain('19d until next move');
  });
});

describe('fmtMoney', () => {
  it('formats amount', () => {
    expect(fmtMoney(5000)).toBe('$5,000');
  });
  it('returns dash for null', () => {
    expect(fmtMoney(null)).toBe('—');
  });
});

describe('fmtDate', () => {
  it('formats a date', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
  it('returns dash for null', () => {
    expect(fmtDate(null)).toBe('—');
  });
});
