import { describe, it, expect } from 'vitest';
import { pickOnThisDay, yearsAgoLabel, type DatedPhoto } from '@/lib/memories/on-this-day';

const now = new Date('2026-07-04T10:00:00');
const p = (id: string, taken_at: string | null): DatedPhoto => ({ id, taken_at });

describe('yearsAgoLabel', () => {
  it('singular / plural', () => {
    expect(yearsAgoLabel(1)).toBe('1 year ago');
    expect(yearsAgoLabel(3)).toBe('3 years ago');
  });
});

describe('pickOnThisDay', () => {
  it('keeps only same month+day in prior years, most-recent first, with labels', () => {
    const res = pickOnThisDay([
      p('a', '2024-07-04T09:00:00'), // 2 years ago
      p('b', '2025-07-04T12:00:00'), // 1 year ago
      p('c', '2023-07-05T12:00:00'), // wrong day
      p('d', '2025-08-04T12:00:00'), // wrong month
      p('e', '2026-07-04T08:00:00'), // today (same year) → excluded
      p('f', null),                  // undated → excluded
      p('g', 'not-a-date'),          // invalid → excluded
    ], now);
    expect(res.map((r) => r.id)).toEqual(['b', 'a']);
    expect(res[0].label).toBe('1 year ago');
    expect(res[1].yearsAgo).toBe(2);
  });

  it('returns [] on an ordinary day with no matches', () => {
    expect(pickOnThisDay([p('x', '2020-01-01T00:00:00')], now)).toEqual([]);
  });

  it('caps the result', () => {
    const many = Array.from({ length: 12 }, (_, i) => p(`m${i}`, `20${10 + i}-07-04T00:00:00`));
    expect(pickOnThisDay(many, now, 5)).toHaveLength(5);
  });
});
