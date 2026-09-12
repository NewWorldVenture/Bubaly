// Offline query read-cache. Production uses the v2 session/access/query
// envelope; legacy helpers remain available for compatibility only.
//
// Last-known-good rows for family-scoped queries, persisted in localStorage so
// an agreeing session can reuse its own stale rows on revisit; the realtime
// hook uses only the partitioned API and re-syncs when connectivity returns.
// Storage is injectable so the logic is unit-testable without a browser.

export interface CacheEntry<T> {
  rows: T[];
  savedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CachePartition = { userId: string; sessionId: string; accessIdentity: string };
export type CacheIdentity = { key: string; signature: string };

/** Complete identity stays in the envelope; a compact key hash is not proof. */
export function cacheIdentity(partition: CachePartition, table: string, familyId: string, deps: unknown[] = []): CacheIdentity | null {
  try {
    const signature = JSON.stringify([2, partition.userId, partition.sessionId, partition.accessIdentity, table, familyId, deps]);
    return { key: `${PREFIX}v2:${hash(signature)}`, signature };
  } catch { return null; }
}

const PREFIX = 'bub:cache:';
const MAX_ROWS = 200;          // keep localStorage lean — enough for first paint
export const CACHE_TTL_MS = 7 * 24 * 3_600_000;

let generation = 0;
const invalidationListeners = new Set<() => void>();
let hasInvalidated = false;
let postPurgeWrites = new WeakMap<StorageLike, Map<string, string>>();

/** In-memory purge boundary; advances even when browser storage is unavailable. */
export function getCacheGeneration(): number { return generation; }
export function subscribeCacheInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/** djb2 — tiny stable hash so distinct queries on one table get distinct keys. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function cacheKey(table: string, familyId: string, deps: unknown[] = []): string {
  let depsSig = '';
  try { depsSig = JSON.stringify(deps) ?? ''; } catch { depsSig = String(deps.length); }
  return `${PREFIX}${familyId}:${table}:${hash(depsSig)}`;
}

function storage(injected?: StorageLike): StorageLike | null {
  if (injected) return injected;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* privacy mode */ }
  return null;
}

/** Last-known rows, or null when absent/expired/corrupt. Never throws. */
export function readCache<T>(key: string, store?: StorageLike, now = Date.now()): CacheEntry<T> | null {
  const s = storage(store);
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    // A failed physical purge can leave readable old rows. After invalidation,
    // only exact values successfully written in this lifetime can be hydrated.
    if (hasInvalidated && postPurgeWrites.get(s)?.get(key) !== raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || !Array.isArray(parsed.rows) || typeof parsed.savedAt !== 'number') return null;
    if (now - parsed.savedAt > CACHE_TTL_MS) { s.removeItem(key); return null; }
    return parsed;
  } catch {
    return null;
  }
}

/** No fallback to legacy entries or to an envelope owned by another query. */
export function readPartitionedCache<T>(identity: CacheIdentity, store?: StorageLike, now = Date.now()): CacheEntry<T> | null {
  const entry = readCache<T>(identity.key, store, now) as (CacheEntry<T> & { version?: unknown; identity?: unknown }) | null;
  return entry?.version === 2 && entry.identity === identity.signature ? { rows: entry.rows, savedAt: entry.savedAt } : null;
}

export function writePartitionedCache<T>(identity: CacheIdentity, rows: T[], store?: StorageLike, now = Date.now()): void {
  writeEntry(identity.key, { version: 2, identity: identity.signature, rows: rows.slice(0, MAX_ROWS), savedAt: now }, store);
}

/** Wipe every offline-cache entry — MUST run on sign-out (family data privacy). */
export function clearAllCache(store?: StorageLike): void {
  generation += 1;
  hasInvalidated = true;
  postPurgeWrites = new WeakMap();
  try {
    const s = storage(store);
    if (!s || !('length' in s) || !('key' in s)) return;
    const ls = s as unknown as Storage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k?.startsWith(PREFIX)) ls.removeItem(k);
    }
  } catch { /* best-effort */ }
  finally {
    for (const listener of invalidationListeners) {
      try { listener(); } catch { /* one observer must not prevent other invalidations */ }
    }
  }
}

/** Persist rows (capped). Quota/serialization failures are silently ignored. */
export function writeCache<T>(key: string, rows: T[], store?: StorageLike, now = Date.now()): void {
  writeEntry(key, { rows: rows.slice(0, MAX_ROWS), savedAt: now }, store);
}

function writeEntry(key: string, entry: object, store?: StorageLike): void {
  const s = storage(store);
  if (!s) return;
  const persist = () => {
    const raw = JSON.stringify(entry);
    s.setItem(key, raw);
    if (hasInvalidated) {
      let writes = postPurgeWrites.get(s);
      if (!writes) { writes = new Map(); postPurgeWrites.set(s, writes); }
      writes.set(key, raw);
    }
  };
  try {
    persist();
  } catch {
    // Quota exceeded — drop our oldest entries and retry once.
    try {
      if ('length' in s && 'key' in s) {
        const ls = s as unknown as Storage;
        for (let i = ls.length - 1; i >= 0; i--) {
          const k = ls.key(i);
          if (k?.startsWith(PREFIX)) ls.removeItem(k);
        }
        persist();
      }
    } catch { /* give up quietly — cache is best-effort */ }
  }
}
