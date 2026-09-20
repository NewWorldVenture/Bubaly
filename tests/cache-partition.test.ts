import { describe, expect, it } from 'vitest';
import { cacheIdentity, cacheKey, clearAllCache, readPartitionedCache, writeCache, writePartitionedCache, type CachePartition, type StorageLike } from '@/lib/offline/cache';

function store() {
  const entries = new Map<string, string>();
  return { entries, get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); } };
}
const A: CachePartition = { userId: 'user-A', sessionId: 'session-A', accessIdentity: 'server-access-A' };
const identity = (partition = A) => cacheIdentity(partition, 'calendar_events', 'family-A', ['same-window'])!;

describe('partitioned persistent cache', () => {
  it('accepts exact owner/session/access/query identity and isolates each changed field', () => {
    const s = store(), key = identity(); writePartitionedCache(key, [{ id: 'private' }], s, 100);
    expect(readPartitionedCache(key, s, 100)?.rows).toEqual([{ id: 'private' }]);
    for (const changed of [{ ...A, userId: 'user-B' }, { ...A, sessionId: 'session-B' }, { ...A, accessIdentity: 'guest-revision' }]) {
      expect(readPartitionedCache(identity(changed), s, 100)).toBeNull();
    }
    expect(readPartitionedCache(cacheIdentity(A, 'calendar_events', 'family-B', ['same-window'])!, s, 100)).toBeNull();
    expect(readPartitionedCache(cacheIdentity(A, 'calendar_events', 'family-A', ['other-window'])!, s, 100)).toBeNull();
  });
  it('checks the envelope even when a key collision or copied value selects old data', () => {
    const s = store(), old = identity(), other = identity({ ...A, userId: 'user-B' });
    writePartitionedCache(old, [{ id: 'private' }], s, 100);
    s.setItem(other.key, s.getItem(old.key)!);
    expect(readPartitionedCache(other, s, 100)).toBeNull();
    expect(readPartitionedCache({ ...other, key: old.key }, s, 100)).toBeNull();
  });
  it('never adopts legacy rows even if copied to the new key', () => {
    const s = store(), key = identity(), legacy = cacheKey('calendar_events', 'family-A', ['same-window']);
    writeCache(legacy, [{ id: 'legacy-private' }], s, 100); s.setItem(key.key, s.getItem(legacy)!);
    expect(readPartitionedCache(key, s, 100)).toBeNull();
  });
  it('preserves row bounds, successful empty entries and exact same-instant fresh writes after failed purge', () => {
    const s = store(), key = identity();
    writePartitionedCache(key, Array.from({ length: 250 }, (_, id) => ({ id })), s, 100);
    expect(readPartitionedCache(key, s, 100)?.rows).toHaveLength(200);
    s.removeItem = () => { throw new Error('deletion denied'); };
    clearAllCache(s); expect(s.entries.size).toBe(1);
    expect(readPartitionedCache(key, s, 100)).toBeNull();
    writePartitionedCache(key, [], s, 100);
    expect(readPartitionedCache(key, s, 100)?.rows).toEqual([]);
  });
  it('does not bless a failed replacement write over surviving previous data', () => {
    const s = store(), key = identity(); writePartitionedCache(key, [{ id: 'old' }], s, 100);
    s.removeItem = () => { throw new Error('remove denied'); }; clearAllCache(s);
    s.setItem = () => { throw new Error('write denied'); };
    writePartitionedCache(key, [{ id: 'new' }], s, 100);
    expect(readPartitionedCache(key, s, 100)).toBeNull();
  });
  it('unserializable queries cannot silently share a fallback identity', () => {
    const deps: unknown[] = []; deps.push(deps); expect(cacheIdentity(A, 'calendar_events', 'family-A', deps)).toBeNull();
  });
  it('unreadable or malformed persistent entries fail closed without throwing', () => {
    const s: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem() {}, removeItem() {} };
    expect(readPartitionedCache(identity(), s)).toBeNull();
    const readable = store(); readable.setItem(identity().key, '{bad-json');
    expect(readPartitionedCache(identity(), readable)).toBeNull();
  });
});
