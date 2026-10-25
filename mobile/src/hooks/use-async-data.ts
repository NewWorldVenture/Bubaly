import { useCallback, useEffect, useRef, useState } from 'react';
import { READ_DEADLINE_MS, withDeadline } from '../lib/deadline';
import { messageFor } from '../lib/errors';
import { deviceLocale, mobileTranslate } from '../lib/mobile-i18n';

export type AsyncData<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Optimistically replace the current data (e.g. after a local mutation). */
  setData: (updater: (prev: T | null) => T | null) => void;
};

type State<T> = { key: string; data: T | null; error: string | null; loading: boolean; refreshing: boolean };

/**
 * Minimal load/refresh state for a screen — no cache library needed.
 *
 * The result is KEYED by `deps`. A screen's data belongs to the family (or
 * owner) it was loaded for: when the active family changes without a sign-out
 * — a switch on the web picked up by `freshFamily()` on focus, foreground or
 * every assistant turn — the previous family's rows must not stay on screen,
 * and actionable, while the new read is in flight, nor for ever if it fails.
 * So `data` and `error` are returned only while they belong to the current
 * deps, and `loading` is true until the current deps have a result. The same
 * key stops a late `setData` (an optimistic flip after a slow write) from
 * landing on another family's list.
 *
 * A refresh for the SAME deps that fails keeps the rows and reports the error
 * beside them: the caller renders `error` whatever `data` holds.
 *
 * Every load runs under a deadline (deadline.ts): the loader receives an
 * AbortSignal to pass to its reads, and a read that has not answered by then
 * settles as "taking longer than expected" instead of loading for ever.
 * Errors are shown as fixed copy; a thrown value's own message reaches the
 * screen only when it is a MobileError (errors.ts).
 */
export function useAsyncData<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[], deadlineMs = READ_DEADLINE_MS): AsyncData<T> {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<State<T>>({ key, data: null, error: null, loading: true, refreshing: false });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;
  const run = useRef(0);

  const load = useCallback(async (asRefresh: boolean) => {
    const id = ++run.current;
    const forKey = keyRef.current;
    setState((prev) => prev.key === forKey
      ? { ...prev, loading: asRefresh ? prev.loading : true, refreshing: asRefresh }
      : { key: forKey, data: null, error: null, loading: true, refreshing: false });
    const own = () => id === run.current && keyRef.current === forKey;
    const deadline = withDeadline(undefined, deadlineMs);
    try {
      const next = await loaderRef.current(deadline.signal);
      if (own()) setState({ key: forKey, data: next, error: null, loading: false, refreshing: false });
    } catch (e) {
      if (own()) {
        console.error('[use-async-data] load failed', e);
        const t = (key: string) => mobileTranslate(deviceLocale(), key);
        const error = deadline.timedOut() ? t('mobileAssistant.timedOut') : messageFor(e, t('mobileAssistant.failed'));
        setState((prev) => prev.key === forKey
          ? { ...prev, error, loading: false, refreshing: false }
          : { key: forKey, data: null, error, loading: false, refreshing: false });
      }
    } finally { deadline.clear(); }
  }, [deadlineMs]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, deps);

  const refresh = useCallback(() => load(true), [load]);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setState((prev) => prev.key === keyRef.current ? { ...prev, data: updater(prev.data) } : prev), []);
  const own = state.key === key;
  return {
    data: own ? state.data : null,
    error: own ? state.error : null,
    loading: !own || state.loading,
    refreshing: own && state.refreshing,
    refresh,
    setData,
  };
}
