import { describe, it, expect } from 'vitest';
import { summarizeMoments, type MomentSummaryInput } from '@/lib/moments/summary';

const m = (id: string, itemIds: string[]): MomentSummaryInput => ({
  event: { id }, prep: { items: itemIds.map((i) => ({ id: i })) },
});

describe('summarizeMoments', () => {
  it('counts ready (all steps done) vs need-prep, and conflicts', () => {
    const moments = [m('a', ['x', 'y']), m('b', ['x']), m('c', ['x', 'y'])];
    const done = { a: ['x', 'y'], b: [], c: ['x'] }; // a ready, b/c partial
    const clashes = { c: ['Sam\'s recital'] };
    expect(summarizeMoments(moments, done, clashes)).toEqual({ total: 3, ready: 1, needPrep: 2, conflicts: 1 });
  });

  it('treats an empty-prep moment as ready', () => {
    expect(summarizeMoments([m('a', [])], {}, {})).toEqual({ total: 1, ready: 1, needPrep: 0, conflicts: 0 });
  });

  it('ignores a clash entry with an empty array', () => {
    expect(summarizeMoments([m('a', ['x'])], { a: ['x'] }, { a: [] }).conflicts).toBe(0);
  });

  it('handles empties', () => {
    expect(summarizeMoments([], {}, {})).toEqual({ total: 0, ready: 0, needPrep: 0, conflicts: 0 });
  });
});
