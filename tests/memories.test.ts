import { describe, it, expect } from 'vitest';
import { groupByMonth, countMemories, type MemoryItem } from '@/lib/memories/timeline';

const item = (id: string, date: string): MemoryItem => ({ id, kind: 'photo', title: id, date });

describe('groupByMonth', () => {
  it('groups into months newest-first with newest item first', () => {
    const months = groupByMonth([
      item('a', '2026-03-02'),
      item('b', '2026-03-20'),
      item('c', '2026-01-15'),
    ]);
    expect(months.map((m) => m.key)).toEqual(['2026-03', '2026-01']);
    expect(months[0].items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(months[0].label).toMatch(/March 2026/);
  });

  it('handles full timestamps and drops undated items', () => {
    const months = groupByMonth([
      item('a', '2026-05-01T12:00:00Z'),
      item('x', 'garbage'),
    ]);
    expect(countMemories(months)).toBe(1);
    expect(months[0].key).toBe('2026-05');
  });
});

describe('countMemories', () => {
  it('sums across months', () => {
    expect(countMemories(groupByMonth([item('a', '2026-01-01'), item('b', '2026-02-01')]))).toBe(2);
    expect(countMemories([])).toBe(0);
  });
});
