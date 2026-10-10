// lib/chores/proof-cleanup.ts — releasing proof uploads without losing proof.
//
// Every cleanup of chore-proof objects, on the server and in the browser, goes
// through here. A path can name an object an EARLIER submission already holds
// (a forged or replayed path, a duplicate in one request, a retry after a
// partial failure), so "this attempt failed" is never enough to delete it.
// Only an object no submission references, checked at the moment of removal,
// is removed; when that cannot be checked, nothing is.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { PROOF_BUCKET } from '@/lib/chores/proof-media';

/** Removes the paths no chore submission in the family references; returns the ones removed. */
export async function releaseUnreferencedProof(
  client: SupabaseClient<Database>,
  familyId: string,
  paths: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(paths)];
  if (!unique.length) return [];
  const { data, error } = await client.from('chore_submissions')
    .select('media_paths').eq('family_id', familyId).overlaps('media_paths', unique);
  if (error) {
    // Unknown is not "unreferenced": keep the objects, an orphan is cheaper than lost proof.
    console.warn('[chore proof] could not check which uploads are referenced; keeping them', error);
    return [];
  }
  const referenced = new Set((data ?? []).flatMap((row) => (row.media_paths as string[] | null) ?? []));
  const free = unique.filter((path) => !referenced.has(path));
  if (!free.length) return [];
  const { error: removeError } = await client.storage.from(PROOF_BUCKET).remove(free);
  if (removeError) {
    console.error('[chore proof] media cleanup failed', removeError);
    return [];
  }
  return free;
}
