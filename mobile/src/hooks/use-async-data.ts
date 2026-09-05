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

/** Minimal load/refresh state for a screen — no cache library needed. */
export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[]): AsyncData<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const run = useRef(0);

  const load = useCallback(async (asRefresh: boolean) => {
    const id = ++run.current;
    if (asRefresh) setRefreshing(true); else setLoading(true);
    try {
      const next = await loaderRef.current();
      if (id === run.current) { setDataState(next); setError(null); }
    } catch (e) {
      if (id === run.current) setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (id === run.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, deps);

  const refresh = useCallback(() => load(true), [load]);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState(updater), []);
  return { data, error, loading, refreshing, refresh, setData };
}
