import { describe, it, expect } from 'vitest';
import { memoryMatches, filterMemories, type SearchableMemory } from '@/lib/family/memory-search';

const mem = (over: Partial<SearchableMemory>): SearchableMemory => ({
  id: 'm1', kind: 'photo', title: 'Beach day', body: null,
  memory_date: '2026-07-04', member_id: null, is_favorite: false, ...over,
});
const names: Record<string, string> = { 'mem-emma': 'Emma', 'mem-jack': 'Jack' };
const nameOf = (id: string | null) => (id ? names[id] ?? '' : '');

describe('memoryMatches', () => {
  it('matches everything when the query is empty', () => {
    expect(memoryMatches(mem({}), {}, nameOf)).toBe(true);
    expect(memoryMatches(mem({}), { query: '   ' }, nameOf)).toBe(true);
  });

  it('matches on title, body, kind, and date (case-insensitive)', () => {
    const m = mem({ title: 'First Day of School', body: 'So proud', kind: 'milestone', memory_date: '2026-09-01' });
    expect(memoryMatches(m, { query: 'school' }, nameOf)).toBe(true);
    expect(memoryMatches(m, { query: 'PROUD' }, nameOf)).toBe(true);
    expect(memoryMatches(m, { query: 'milestone' }, nameOf)).toBe(true);
    expect(memoryMatches(m, { query: '2026-09' }, nameOf)).toBe(true);
    expect(memoryMatches(m, { query: 'soccer' }, nameOf)).toBe(false);
  });

  it('matches on the resolved member name (who)', () => {
    const m = mem({ title: 'Recital', member_id: 'mem-emma' });
    expect(memoryMatches(m, { query: 'emma' }, nameOf)).toBe(true);
    expect(memoryMatches(m, { query: 'jack' }, nameOf)).toBe(false);
  });

  it('respects favoritesOnly', () => {
    expect(memoryMatches(mem({ is_favorite: false }), { favoritesOnly: true }, nameOf)).toBe(false);
    expect(memoryMatches(mem({ is_favorite: true }), { favoritesOnly: true }, nameOf)).toBe(true);
    // favoritesOnly + query both apply
    expect(memoryMatches(mem({ is_favorite: true, title: 'Trip' }), { favoritesOnly: true, query: 'trip' }, nameOf)).toBe(true);
    expect(memoryMatches(mem({ is_favorite: true, title: 'Trip' }), { favoritesOnly: true, query: 'zzz' }, nameOf)).toBe(false);
  });
});

describe('filterMemories', () => {
  it('filters a list and preserves order', () => {
    const list = [
      mem({ id: 'a', title: 'Beach trip', member_id: 'mem-emma' }),
      mem({ id: 'b', title: 'Soccer game', member_id: 'mem-jack', is_favorite: true }),
      mem({ id: 'c', title: 'Beach cleanup' }),
    ];
    expect(filterMemories(list, { query: 'beach' }, nameOf).map((m) => m.id)).toEqual(['a', 'c']);
    expect(filterMemories(list, { favoritesOnly: true }, nameOf).map((m) => m.id)).toEqual(['b']);
    expect(filterMemories(list, { query: 'emma' }, nameOf).map((m) => m.id)).toEqual(['a']);
  });
});
