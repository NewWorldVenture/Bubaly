'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isMissingTableError } from '@/lib/supabase/errors';
import type { SupabaseBrowser } from '@/lib/supabase/types';

type Fetcher<T> = (supabase: SupabaseBrowser) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Fetches a family-scoped list and keeps it live via Supabase Realtime.
 * Re-runs the fetcher whenever the watched table changes for this family.
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
      } else {
        setError(err.message);
      }
    } else {
      setData(rows ?? []);
      setError(null);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`${table}:${familyId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `family_id=eq.${familyId}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [table, familyId, refresh]);

  return { data, loading, error, refresh, setData };
}
