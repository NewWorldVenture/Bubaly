import { describe, it, expect } from 'vitest';
import { cacheKey, readCache, writeCache, CACHE_TTL_MS, type StorageLike } from '@/lib/offline/cache';

function fakeStore(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('cacheKey', () => {
  it('separates tables, families, and query shapes', () => {
    const a = cacheKey('chores', 'fam1', ['x']);
    expect(a).toBe(cacheKey('chores', 'fam1', ['x']));
    expect(a).not.toBe(cacheKey('chores', 'fam2', ['x']));
    expect(a).not.toBe(cacheKey('todos', 'fam1', ['x']));
    expect(a).not.toBe(cacheKey('chores', 'fam1', ['y']));
  });
});

describe('read/write round trip', () => {
  it('returns what was written, capped at 200 rows', () => {
    const s = fakeStore();
    const key = cacheKey('chores', 'fam1');
    writeCache(key, Array.from({ length: 500 }, (_, i) => ({ i })), s);
    const back = readCache<{ i: number }>(key, s);
    expect(back!.rows).toHaveLength(200);
    expect(back!.rows[0]).toEqual({ i: 0 });
  });

  it('expires after the TTL and clears the entry', () => {
    const s = fakeStore();
    const key = cacheKey('chores', 'fam1');
    writeCache(key, [{ a: 1 }], s, 1_000);
    expect(readCache(key, s, 1_000 + CACHE_TTL_MS - 1)).not.toBeNull();
    expect(readCache(key, s, 1_000 + CACHE_TTL_MS + 1)).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it('never throws on corrupt or missing entries', () => {
    const s = fakeStore();
    s.setItem('bad', '{not json');
    expect(readCache('bad', s)).toBeNull();
    s.setItem('shape', JSON.stringify({ rows: 'nope', savedAt: 'later' }));
    expect(readCache('shape', s)).toBeNull();
    expect(readCache('absent', s)).toBeNull();
  });
});
