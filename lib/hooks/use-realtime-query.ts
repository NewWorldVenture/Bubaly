'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isMissingTableError } from '@/lib/supabase/errors';
import { cacheKey, readCache, writeCache } from '@/lib/offline/cache';
import { realtimeChannelFor } from '@/lib/realtime/published-tables';
import type { SupabaseBrowser } from '@/lib/supabase/types';

type Fetcher<T> = (supabase: SupabaseBrowser) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Fetches a family-scoped list and keeps it live via Supabase Realtime.
 * Re-runs the fetcher whenever the watched table changes for this family.
 *
 * Offline-first reads (gap #13 v1): the last successful result is cached in
 * localStorage, hydrated on mount for instant paint, served when the network
 * is down (no scary error), and re-synced automatically on reconnect.
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
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const key = cacheKey(table, familyId, deps);
  const hydratedRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const { data: rows, error: err } = await fetcherRef.current(supabase);
    if (err) {
      // A not-yet-provisioned feature (pending migration) should look empty, not
      // broken — degrade missing-table errors to an empty list instead of a
      // scary error banner. Real errors still surface.
      if (isMissingTableError(err)) {
        setData([]);
        setError(null);
      } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
        // Offline: keep showing the cached rows quietly; reconnect re-syncs.
        setError(null);
      } else {
        setError(err.message);
      }
    } else {
      setData(rows ?? []);
      setError(null);
      writeCache(key, rows ?? []);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // Instant paint from the last-known rows (once per key).
    if (hydratedRef.current !== key) {
      hydratedRef.current = key;
      const cached = readCache<T>(key);
      if (cached && cached.rows.length > 0) {
        setData(cached.rows);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, key]);

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

  return { data, loading, error, refresh, setData };
}
