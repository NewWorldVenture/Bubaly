import { describe, expect, it } from 'vitest';
import {
  entriesByCategory,
  entriesByMonth,
  yearbookSummary,
  fmtDate,
  type YearbookLike,
  type EntryLike,
} from '@/lib/yearbook/yearbook';

function yb(overrides: Partial<YearbookLike> & { id: string }): YearbookLike {
  return { title: 'Test', year: 2026, is_published: false, ...overrides };
}

function entry(overrides: Partial<EntryLike> & { id: string }): EntryLike {
  return { yearbook_id: 'y1', title: 'Test', category: 'Family', entry_date: null, member_id: null, ...overrides };
}

describe('entriesByCategory', () => {
  it('groups and sorts by count', () => {
    const entries = [
      entry({ id: 'a', category: 'Travel' }),
      entry({ id: 'b', category: 'Family' }),
      entry({ id: 'c', category: 'Travel' }),
    ];
    const result = entriesByCategory(entries);
    expect(result[0]).toEqual({ category: 'Travel', count: 2 });
    expect(result[1]).toEqual({ category: 'Family', count: 1 });
  });
});

describe('entriesByMonth', () => {
  it('groups by month', () => {
    const entries = [
      entry({ id: 'a', entry_date: '2026-03-15' }),
      entry({ id: 'b', entry_date: '2026-03-20' }),
      entry({ id: 'c', entry_date: '2026-06-01' }),
    ];
    const result = entriesByMonth(entries);
    expect(result.find((m) => m.month === 'Mar')?.count).toBe(2);
    expect(result.find((m) => m.month === 'Jun')?.count).toBe(1);
  });
});

describe('yearbookSummary', () => {
  it('handles empty', () => {
    const s = yearbookSummary([], []);
    expect(s.text).toBe('No yearbooks yet');
  });
  it('reports entries and published', () => {
    const ybs = [yb({ id: 'a', is_published: true })];
    const entries = [entry({ id: 'e1' }), entry({ id: 'e2' })];
    const s = yearbookSummary(ybs, entries);
    expect(s.totalEntries).toBe(2);
    expect(s.published).toBe(1);
    expect(s.text).toContain('2 memories');
    expect(s.text).toContain('1 published');
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
