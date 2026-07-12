// Offline read-cache (competitor gap #13, v1: read-side).
//
// Last-known-good rows for family-scoped queries, persisted in localStorage so
// pages paint instantly on revisit and keep working without a connection; the
// realtime hook re-syncs automatically the moment connectivity returns.
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

const PREFIX = 'bub:cache:';
const MAX_ROWS = 200;          // keep localStorage lean — enough for first paint
export const CACHE_TTL_MS = 7 * 24 * 3_600_000;

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
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || !Array.isArray(parsed.rows) || typeof parsed.savedAt !== 'number') return null;
    if (now - parsed.savedAt > CACHE_TTL_MS) { s.removeItem(key); return null; }
    return parsed;
  } catch {
    return null;
  }
}

/** Wipe every offline-cache entry — MUST run on sign-out (family data privacy). */
export function clearAllCache(store?: StorageLike): void {
  const s = storage(store);
  if (!s || !('length' in s) || !('key' in s)) {
    // Fake stores in tests expose only get/set/remove — nothing enumerable to wipe.
    return;
  }
  try {
    const ls = s as unknown as Storage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k?.startsWith(PREFIX)) ls.removeItem(k);
    }
  } catch { /* best-effort */ }
}

/** Persist rows (capped). Quota/serialization failures are silently ignored. */
export function writeCache<T>(key: string, rows: T[], store?: StorageLike, now = Date.now()): void {
  const s = storage(store);
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify({ rows: rows.slice(0, MAX_ROWS), savedAt: now }));
  } catch {
    // Quota exceeded — drop our oldest entries and retry once.
    try {
      if ('length' in s && 'key' in s) {
        const ls = s as unknown as Storage;
        for (let i = ls.length - 1; i >= 0; i--) {
          const k = ls.key(i);
          if (k?.startsWith(PREFIX)) ls.removeItem(k);
        }
        s.setItem(key, JSON.stringify({ rows: rows.slice(0, MAX_ROWS), savedAt: now }));
      }
    } catch { /* give up quietly — cache is best-effort */ }
  }
}
