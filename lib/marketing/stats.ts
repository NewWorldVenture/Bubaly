import 'server-only';
import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export type PublicStats = { families: number; members: number; tasksCompleted: number };

// Anonymous client (not cookie-bound) so this works during static generation
// and on public marketing pages. Reads only the public_stats() RPC, which
// returns non-identifying aggregate counts.
function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

/** Real aggregate counts for the public site, cached for an hour. Degrades to
 *  zeros if Supabase is unreachable so marketing pages always render. */
export const getPublicStats = unstable_cache(
  async (): Promise<PublicStats> => {
    try {
      const { data, error } = await anonClient().rpc('public_stats');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        families: Number(row?.families ?? 0),
        members: Number(row?.members ?? 0),
        tasksCompleted: Number(row?.tasks_completed ?? 0),
      };
    } catch {
      return { families: 0, members: 0, tasksCompleted: 0 };
    }
  },
  ['public-stats'],
  { revalidate: 3600 },
);
