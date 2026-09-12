'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { cacheKey, getCacheGeneration, readCache, subscribeCacheInvalidation, writeCache } from '@/lib/offline/cache';
import { realtimeChannelFor } from '@/lib/realtime/published-tables';
import type { SupabaseBrowser } from '@/lib/supabase/types';

type Fetcher<T> = (supabase: SupabaseBrowser) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
type QueryScope = { key: string; generation: number; active: boolean; request: number };
const getServerCacheGeneration = () => 0;
type QueryState<T> = {
  scope: QueryScope;
  data: T[];
  loading: boolean;
  error: string | null;
  stale: boolean;
  updatedAt: number | null;
};

function emptyState<T>(scope: QueryScope): QueryState<T> {
  return { scope, data: [], loading: true, error: null, stale: false, updatedAt: null };
}

/**
 * Fetches a family-scoped list and keeps it live via Supabase Realtime.
 * Re-runs the fetcher whenever the watched table changes for this family.
 *
 * Last successful rows can be hydrated from this query's cache. Cached/failed
 * reads are marked stale; failures remain errors even when cached rows exist.
 * The caller supplies any user/role/query distinctions through deps: family
 * and table alone do not establish authorization or a user-specific cache.
 */
export function useRealtimeQuery<T>({
  table,
  familyId,
  fetcher,
  deps = [],
}: {
  table: string;
  familyId: string;
  fetcher: Fetcher<T>;
  deps?: unknown[];
}) {
  const key = cacheKey(table, familyId, deps);
  const generation = useSyncExternalStore(subscribeCacheInvalidation, getCacheGeneration, getServerCacheGeneration);
  const scope = useMemo<QueryScope>(() => ({ key, generation, active: false, request: 0 }), [key, generation]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const fetcherRef = useRef({ scope, fetcher });
  fetcherRef.current = { scope, fetcher };
  const [state, setState] = useState<QueryState<T>>(() => emptyState(scope));

  const refresh = useCallback(async () => {
    // Old online/realtime callbacks must not pair a new fetcher with an old key.
    if (!scope.active || activeScope.current !== scope || fetcherRef.current.scope !== scope || scope.generation !== getCacheGeneration()) return;
    const fetchCurrent = fetcherRef.current.fetcher;
    const request = ++scope.request;
    const isCurrent = () => scope.active && activeScope.current === scope && scope.request === request
      && scope.generation === getCacheGeneration();
    try {
      const { data: rows, error: err } = await fetchCurrent(createClient());
      if (!isCurrent()) return;
      if (err) throw err;
      const data = rows ?? [];
      const updatedAt = Date.now();
      writeCache(scope.key, data);
      setState(previous => isCurrent()
        ? { scope, data, loading: false, error: null, stale: false, updatedAt }
        : previous);
    } catch (cause) {
      if (!isCurrent()) return;
      const error = describeDbError(cause, 'Could not load data. Please try again.');
      setState(previous => isCurrent()
        ? { ...(previous.scope === scope ? previous : emptyState<T>(scope)), loading: false, error, stale: true }
        : previous);
    }
  }, [scope]);

  const setData = useCallback((update: SetStateAction<T[]>) => {
    if (!scope.active || activeScope.current !== scope || scope.generation !== getCacheGeneration()) return;
    // A caller's local mutation supersedes reads already in flight. Preserve
    // functional-setter batching; do not persist an unverified local mutation.
    scope.request += 1;
    setState(previous => {
      if (!scope.active || activeScope.current !== scope || scope.generation !== getCacheGeneration()) return previous;
      const current = previous.scope === scope ? previous : emptyState<T>(scope);
      const data = typeof update === 'function' ? update(current.data) : update;
      if (scope.generation !== getCacheGeneration()) return previous;
      return { ...current, data, loading: false, stale: true };
    });
  }, [scope]);

  useEffect(() => {
    scope.active = true;
    const cached = readCache<T>(scope.key);
    setState(cached
      ? { scope, data: cached.rows, loading: false, error: null, stale: true, updatedAt: cached.savedAt }
      : emptyState<T>(scope));
    void refresh();
    return () => { scope.active = false; scope.request += 1; };
  }, [refresh, scope]);

  // Re-sync the moment connectivity returns.
  useEffect(() => {
    const onOnline = () => { void refresh(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  useEffect(() => {
    // Only subscribe to a table the database actually publishes. Realtime
    // happily accepts a channel on an unpublished table and then never sends
    // anything, so the socket looks healthy while the screen quietly goes
    // stale. Holding it costs a connection slot and phone battery and buys
    // nothing; the mount/deps refetch above is the honest refresh for those.
    const spec = realtimeChannelFor(table, familyId);
    if (!spec) return;
    const supabase = createClient();
    const channel = supabase
      .channel(spec.name)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: spec.filter },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [table, familyId, refresh]);

  // Effects run after render. Mask an old owner's state on the first render
  // of a new key, including an A -> B -> A switch before requests finish.
  const visible = state.scope === scope ? state : emptyState<T>(scope);
  return { data: visible.data, loading: visible.loading, error: visible.error, stale: visible.stale, updatedAt: visible.updatedAt, refresh, setData };
}
