'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { cacheIdentity, cacheKey, getCacheGeneration, readPartitionedCache, subscribeCacheInvalidation, writePartitionedCache } from '@/lib/offline/cache';
import { isAuthenticatedCacheScopeCurrent, useAuthenticatedCacheScope } from '@/lib/offline/cache-scope';
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
 * Persistent cache uses the central agreeing session and server access
 * identity. Callers supply query distinctions through deps; without a cache
 * provider this hook remains network-only and never hydrates persisted rows.
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
  const authScope = useAuthenticatedCacheScope();
  const queryIdentity = authScope?.partition && authScope.familyId === familyId
    ? cacheIdentity(authScope.partition, table, familyId, deps) : null;
  const partitionedKey = queryIdentity?.key ?? null;
  const partitionedSignature = queryIdentity?.signature ?? null;
  const identityKey = `${authScope?.key ?? 'network-only'}:${queryIdentity?.signature ?? key}`;
  const generation = useSyncExternalStore(subscribeCacheInvalidation, getCacheGeneration, getServerCacheGeneration);
  const scope = useMemo(() => ({ key: identityKey, generation, active: false, request: 0,
    authScope, queryIdentity: partitionedKey && partitionedSignature ? { key: partitionedKey, signature: partitionedSignature } : null,
  }), [identityKey, generation, authScope, partitionedKey, partitionedSignature]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const fetcherRef = useRef({ scope, fetcher });
  fetcherRef.current = { scope, fetcher };
  const [state, setState] = useState<QueryState<T>>(() => emptyState(scope));

  const refresh = useCallback(async () => {
    // Old online/realtime callbacks must not pair a new fetcher with an old key.
    if (!scope.active || activeScope.current !== scope || fetcherRef.current.scope !== scope || scope.generation !== getCacheGeneration()) return;
    if (scope.authScope && (!isAuthenticatedCacheScopeCurrent(scope.authScope) || scope.authScope.familyId !== familyId)) return;
    const fetchCurrent = fetcherRef.current.fetcher;
    const request = ++scope.request;
    const isCurrent = () => scope.active && activeScope.current === scope && scope.request === request
      && scope.generation === getCacheGeneration()
      && (!scope.authScope || isAuthenticatedCacheScopeCurrent(scope.authScope));
    try {
      const { data: rows, error: err } = await fetchCurrent(createClient());
      if (!isCurrent()) return;
      if (err) throw err;
      const data = rows ?? [];
      const updatedAt = Date.now();
      if (scope.queryIdentity) writePartitionedCache(scope.queryIdentity, data);
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
  }, [scope, familyId]);

  const setData = useCallback((update: SetStateAction<T[]>) => {
    if (!scope.active || activeScope.current !== scope || scope.generation !== getCacheGeneration()) return;
    if (scope.authScope && !isAuthenticatedCacheScopeCurrent(scope.authScope)) return;
    // A caller's local mutation supersedes reads already in flight. Preserve
    // functional-setter batching; do not persist an unverified local mutation.
    scope.request += 1;
    setState(previous => {
      if (!scope.active || activeScope.current !== scope || scope.generation !== getCacheGeneration()) return previous;
      if (scope.authScope && !isAuthenticatedCacheScopeCurrent(scope.authScope)) return previous;
      const current = previous.scope === scope ? previous : emptyState<T>(scope);
      const data = typeof update === 'function' ? update(current.data) : update;
      if (scope.generation !== getCacheGeneration()) return previous;
      if (scope.authScope && !isAuthenticatedCacheScopeCurrent(scope.authScope)) return previous;
      return { ...current, data, loading: false, stale: true };
    });
  }, [scope]);

  useEffect(() => {
    scope.active = true;
    const authorized = !scope.authScope || isAuthenticatedCacheScopeCurrent(scope.authScope);
    const cached = authorized && scope.queryIdentity ? readPartitionedCache<T>(scope.queryIdentity) : null;
    setState(cached
      ? { scope, data: cached.rows, loading: false, error: null, stale: true, updatedAt: cached.savedAt }
      : emptyState<T>(scope));
    if (scope.authScope && (!authorized || scope.authScope.familyId !== familyId)) {
      const error = scope.authScope.familyId !== familyId
        ? scope.authScope.familyMismatchError : scope.authScope.error;
      if (error) setState({ ...emptyState<T>(scope), loading: false, error });
      return () => { scope.active = false; scope.request += 1; };
    }
    void refresh();
    return () => { scope.active = false; scope.request += 1; };
  }, [refresh, scope, familyId]);

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
    if (scope.authScope && (!isAuthenticatedCacheScopeCurrent(scope.authScope) || scope.authScope.familyId !== familyId)) return;
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
  }, [table, familyId, refresh, scope]);

  // Effects run after render. Mask an old owner's state on the first render
  // of a new key, including an A -> B -> A switch before requests finish.
  const visible = state.scope === scope ? state : emptyState<T>(scope);
  return { data: visible.data, loading: visible.loading, error: visible.error, stale: visible.stale, updatedAt: visible.updatedAt, refresh, setData };
}
