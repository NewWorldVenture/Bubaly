import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncData<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Optimistically replace the current data (e.g. after a local mutation). */
  setData: (updater: (prev: T | null) => T | null) => void;
};

type Loaded<T> = { deps: readonly unknown[]; data: T | null; error: string | null };

const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Minimal load/refresh state for a screen — no cache library needed.
 *
 * A result belongs to the deps it was loaded for. The tabs stay mounted while
 * the active family changes, so the first render with new deps must already
 * stop showing — and stop handing to mutations — the previous family's rows,
 * rather than keeping them until (or, after a failed read, beyond) the new load.
 */
export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[]): AsyncData<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ deps, data: null, error: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const run = useRef(0);

  const load = useCallback(async (asRefresh: boolean) => {
    const id = ++run.current;
    const forDeps = depsRef.current;
    if (asRefresh) setRefreshing(true); else setLoading(true);
    try {
      const next = await loaderRef.current();
      if (id === run.current) setLoaded({ deps: forDeps, data: next, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Something went wrong.';
      // A failed refresh keeps what these deps already show; nothing else does.
      if (id === run.current) setLoaded((prev) => ({ deps: forDeps, data: sameDeps(prev.deps, forDeps) ? prev.data : null, error }));
    } finally {
      if (id === run.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, deps);

  const refresh = useCallback(() => load(true), [load]);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setLoaded((prev) => (
    sameDeps(prev.deps, depsRef.current) ? { ...prev, data: updater(prev.data) } : prev
  )), []);
  const own = sameDeps(loaded.deps, deps);
  return { data: own ? loaded.data : null, error: own ? loaded.error : null, loading: loading || !own, refreshing: own && refreshing, refresh, setData };
}
